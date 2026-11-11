import os
import io
import re
import uuid
import zipfile
import shutil
import threading
import time
import json
import urllib.request
import urllib.error
from pathlib import Path
from typing import List
from fastapi import FastAPI, BackgroundTasks, Header, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel, Field

app = FastAPI(title="YTAgent Wan GPU Worker", version="1.0.0")
ROOT = Path(os.environ.get("YT_WORKER_DIR", "/tmp/ytagent-wan-worker"))
ROOT.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("YT_AGENT_WORKER_TOKEN", "")
JOBS = {}
GPU_LOCK = threading.Lock()
ACTIVE_JOB = None
PIPE = None
POLL_THREAD = None
SERVER_URL = os.environ.get("YT_AGENT_SERVER_URL", "").rstrip("/")

class Scene(BaseModel):
    prompt: str = Field(min_length=30, max_length=1800)

class GenerateRequest(BaseModel):
    scenes: List[Scene] = Field(min_length=5, max_length=10)
    seed: int = 20261110

def authorize(value):
    if not TOKEN:
        raise HTTPException(status_code=503, detail="Worker token is not configured.")
    if value != "Bearer " + TOKEN:
        raise HTTPException(status_code=401, detail="Invalid worker token.")

def get_pipeline():
    global PIPE
    if PIPE is not None:
        return PIPE
    import torch
    from diffusers import AutoencoderKLWan, WanPipeline
    from diffusers.schedulers.scheduling_unipc_multistep import UniPCMultistepScheduler
    model_id = os.environ.get("WAN_MODEL_ID", "Wan-AI/Wan2.1-T2V-1.3B-Diffusers")
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    vae = AutoencoderKLWan.from_pretrained(model_id, subfolder="vae", torch_dtype=torch.float32)
    PIPE = WanPipeline.from_pretrained(model_id, vae=vae, torch_dtype=dtype)
    PIPE.scheduler = UniPCMultistepScheduler(
        prediction_type="flow_prediction",
        use_flow_sigmas=True,
        num_train_timesteps=1000,
        flow_shift=3.0
    )
    if torch.cuda.is_available():
        PIPE.enable_model_cpu_offload()
        try:
            PIPE.enable_vae_slicing()
            PIPE.enable_vae_tiling()
        except Exception:
            pass
    else:
        raise RuntimeError("A CUDA GPU is required. Enable a GPU accelerator in Kaggle.")
    return PIPE

def send_scene_to_server(remote_job_id, index, clip_path):
    url = f"{SERVER_URL}/api/worker/jobs/{remote_job_id}/scenes/{index}"
    data = Path(clip_path).read_bytes()
    request = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/octet-stream"}
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.loads(response.read().decode("utf-8") or "{}")

def report_remote_failure(remote_job_id, message):
    if not SERVER_URL or not TOKEN:
        return
    try:
        payload = json.dumps({"error": str(message)[:500]}).encode("utf-8")
        request = urllib.request.Request(
            f"{SERVER_URL}/api/worker/jobs/{remote_job_id}/fail",
            data=payload, method="POST",
            headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
    except Exception as exc:
        print("Could not report GPU worker failure to YTAgent:", str(exc)[:200])

def poll_railway():
    print("YTAgent outbound GPU polling is active. No Cloudflare tunnel is required.")
    while True:
        try:
            request = urllib.request.Request(
                SERVER_URL + "/api/worker/next",
                headers={"Authorization": "Bearer " + TOKEN}
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    job = json.loads(response.read().decode("utf-8") or "{}")
            except urllib.error.HTTPError as exc:
                if exc.code == 204:
                    time.sleep(12)
                    continue
                raise
            remote_id = str(job.get("job_id", ""))
            prompts = job.get("prompts", [])
            if not re.fullmatch(r"[a-f0-9]{32}", remote_id) or len(prompts) != 10:
                print("YTAgent returned an invalid GPU job. Skipping it.")
                time.sleep(5)
                continue
            local_id = "railway-" + remote_id
            print("Claimed YTAgent video job:", remote_id)
            run_job(local_id, prompts, int(job.get("seed", 20261110)), remote_job_id=remote_id)
            result = JOBS.get(local_id, {})
            if result.get("status") == "failed":
                report_remote_failure(remote_id, result.get("message", "GPU generation failed."))
            else:
                print("Finished sending all scenes to YTAgent:", remote_id)
        except Exception as exc:
            print("YTAgent polling connection failed:", str(exc)[:250])
            time.sleep(20)

def run_job(job_id, prompts, seed, remote_job_id=None):
    global ACTIVE_JOB
    work = ROOT / job_id
    work.mkdir(parents=True, exist_ok=True)
    lock_acquired = False
    try:
        lock_acquired = GPU_LOCK.acquire(blocking=False)
        if not lock_acquired:
            raise RuntimeError("The GPU worker is busy with another generation.")
        ACTIVE_JOB = job_id
        JOBS[job_id]["status"] = "loading"
        JOBS[job_id]["message"] = "Loading Wan video model into GPU memory."
        pipe = get_pipeline()
        import torch
        from diffusers.utils import export_to_video
        clips = []
        for index, prompt in enumerate(prompts):
            JOBS[job_id]["status"] = "generating"
            JOBS[job_id]["progress"] = int(index * 100 / len(prompts))
            JOBS[job_id]["message"] = f"Generating cinematic scene {index + 1} of {len(prompts)}."
            generator = torch.Generator(device="cuda").manual_seed(seed + index)
            result = pipe(
                prompt=prompt,
                height=832,
                width=480,
                num_frames=97,
                num_inference_steps=int(os.environ.get("WAN_STEPS", "20")),
                guidance_scale=5.0,
                generator=generator
            )
            frames = result.frames[0]
            clip_path = work / f"scene-{index:02d}.mp4"
            export_to_video(frames, str(clip_path), fps=16)
            clips.append(clip_path)
            if remote_job_id:
                send_scene_to_server(remote_job_id, index, clip_path)
                print(f"Uploaded scene {index + 1} of {len(prompts)} to YTAgent.")
            del result, frames, generator
            torch.cuda.empty_cache()
        zip_path = None
        if not remote_job_id:
            zip_path = work / "scenes.zip"
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for clip in clips:
                    archive.write(clip, clip.name)
        JOBS[job_id].update({
            "status": "completed",
            "progress": 100,
            "message": "All AI-generated video scenes are ready.",
            "result": str(zip_path) if zip_path else None
        })
    except Exception as exc:
        JOBS[job_id].update({"status": "failed", "message": str(exc)[:700]})
    finally:
        if lock_acquired:
            GPU_LOCK.release()
        ACTIVE_JOB = None

@app.get("/health")
def health():
    return {"ok": True, "service": "ytagent-wan-worker", "model": os.environ.get("WAN_MODEL_ID", "Wan-AI/Wan2.1-T2V-1.3B-Diffusers")}

@app.post("/generate")
def generate(body: GenerateRequest, background: BackgroundTasks, authorization: str = Header(default="")):
    global ACTIVE_JOB
    authorize(authorization)
    if ACTIVE_JOB is not None:
        raise HTTPException(status_code=409, detail="GPU worker is busy. Wait for the current job to finish.")
    job_id = uuid.uuid4().hex
    ACTIVE_JOB = job_id
    JOBS[job_id] = {"status": "queued", "progress": 0, "message": "Generation queued."}
    background.add_task(run_job, job_id, [scene.prompt for scene in body.scenes], body.seed)
    return {"job_id": job_id, "status": "queued"}

@app.get("/jobs/{job_id}")
def job_status(job_id: str, authorization: str = Header(default="")):
    authorize(authorization)
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Generation job not found. The GPU notebook may have restarted.")
    return {key: value for key, value in job.items() if key != "result"}

@app.get("/jobs/{job_id}/download")
def download(job_id: str, authorization: str = Header(default="")):
    authorize(authorization)
    job = JOBS.get(job_id)
    if not job or job.get("status") != "completed" or not job.get("result"):
        raise HTTPException(status_code=409, detail="Generated scenes are not ready.")
    file_path = Path(job["result"])
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Generated scene archive has expired.")
    return StreamingResponse(io.BytesIO(file_path.read_bytes()), media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="ytagent-scenes.zip"'})


@app.get("/jobs/{job_id}/scenes/{scene_index}")
def download_scene(job_id: str, scene_index: int, authorization: str = Header(default="")):
    authorize(authorization)
    job = JOBS.get(job_id)
    if not job or job.get("status") != "completed":
        raise HTTPException(status_code=409, detail="Generated scenes are not ready.")
    if scene_index < 0 or scene_index >= 10:
        raise HTTPException(status_code=404, detail="Scene index is outside the supported range.")
    file_path = ROOT / job_id / ("scene-" + str(scene_index).zfill(2) + ".mp4")
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Generated scene file has expired or is missing.")
    return FileResponse(str(file_path), media_type="video/mp4",
                        filename="scene-" + str(scene_index + 1).zfill(2) + ".mp4")


@app.on_event("startup")
def start_railway_polling():
    global POLL_THREAD
    if SERVER_URL and TOKEN:
        if not SERVER_URL.startswith("https://"):
            print("YT_AGENT_SERVER_URL must use HTTPS. Outbound polling was not started.")
            return
        if POLL_THREAD is None or not POLL_THREAD.is_alive():
            POLL_THREAD = threading.Thread(target=poll_railway, daemon=True, name="ytagent-railway-poller")
            POLL_THREAD.start()
    else:
        print("YTAgent outbound polling is disabled. Set YT_AGENT_SERVER_URL and YT_AGENT_WORKER_TOKEN.")
