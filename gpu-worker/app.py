import os
import io
import re
import uuid
import zipfile
import shutil
import threading
from pathlib import Path
from typing import List
from fastapi import FastAPI, BackgroundTasks, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(title="YTAgent Wan GPU Worker", version="1.0.0")
ROOT = Path(os.environ.get("YT_WORKER_DIR", "/tmp/ytagent-wan-worker"))
ROOT.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("YT_AGENT_WORKER_TOKEN", "")
JOBS = {}
GPU_LOCK = threading.Lock()
ACTIVE_JOB = None
PIPE = None

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

def run_job(job_id, prompts, seed):
    global ACTIVE_JOB
    work = ROOT / job_id
    work.mkdir(parents=True, exist_ok=True)
    try:
        if not GPU_LOCK.acquire(blocking=False):
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
                height=480,
                width=832,
                num_frames=81,
                num_inference_steps=int(os.environ.get("WAN_STEPS", "20")),
                guidance_scale=5.0,
                generator=generator
            )
            frames = result.frames[0]
            clip_path = work / f"scene-{index:02d}.mp4"
            export_to_video(frames, str(clip_path), fps=16)
            clips.append(clip_path)
            del result, frames, generator
            torch.cuda.empty_cache()
        zip_path = work / "scenes.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for clip in clips:
                archive.write(clip, clip.name)
        JOBS[job_id].update({
            "status": "completed",
            "progress": 100,
            "message": "All AI-generated video scenes are ready.",
            "result": str(zip_path)
        })
    except Exception as exc:
        JOBS[job_id].update({"status": "failed", "message": str(exc)[:700]})
    finally:
        if GPU_LOCK.locked():
            GPU_LOCK.release()
        ACTIVE_JOB = None

@app.get("/health")
def health():
    return {"ok": True, "service": "ytagent-wan-worker", "model": os.environ.get("WAN_MODEL_ID", "Wan-AI/Wan2.1-T2V-1.3B-Diffusers")}

@app.post("/generate")
def generate(body: GenerateRequest, background: BackgroundTasks, authorization: str = Header(default="")):
    authorize(authorization)
    if ACTIVE_JOB is not None:
        raise HTTPException(status_code=409, detail="GPU worker is busy. Wait for the current job to finish.")
    job_id = uuid.uuid4().hex
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
