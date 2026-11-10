# YTAgent free GPU video worker

This worker runs the open Wan 2.1 T2V 1.3B Diffusers model on a temporary GPU notebook. Railway remains the YTAgent web app and calls this worker over a temporary Cloudflare Tunnel URL.

## Important limits

- This is genuine text-to-video generation, not a photo slideshow.
- The 1.3B model creates short 480p landscape clips. YTAgent crops them for vertical Shorts.
- Ten 5-second scenes can take a long time on a free GPU. Free notebook sessions can disconnect or hit usage limits.
- Keep the Kaggle notebook running while YTAgent generates a video.
- No paid video API is used. GPU availability is not guaranteed.
- This is a first real-video engine, not a promise of Zack D Films-level quality. The 1.3B model is a constrained free-compute starting point.

## Start on Kaggle

1. Open Kaggle, create a new Notebook, turn **Internet on**, and select a **GPU** accelerator.
2. Clone this repository and install the worker dependencies:

```bash
!git clone https://github.com/qingremzy/YTAgent.git
%cd YTAgent/gpu-worker
!pip install -r requirements.txt
!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared
!chmod +x /usr/local/bin/cloudflared
```

3. Create a long random token and keep it private. Run this cell:

```python
import secrets, os
token = secrets.token_urlsafe(36)
os.environ["YT_AGENT_WORKER_TOKEN"] = token
print("Copy this token into Railway as YT_AGENT_WORKER_TOKEN:", token)
```

4. Start the worker and tunnel:

```python
import subprocess, time, re, os
worker = subprocess.Popen(
    ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"],
    cwd="/kaggle/working/YTAgent/gpu-worker",
    stdout=subprocess.DEVNULL,
    stderr=subprocess.STDOUT
)
tunnel = subprocess.Popen(
    ["cloudflared", "tunnel", "--url", "http://127.0.0.1:7860"],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True
)
for line in iter(tunnel.stdout.readline, ""):
    match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
    if match:
        print("Set this in Railway as VIDEO_WORKER_URL:", match.group(0))
        break
```

5. In Railway Variables, add:
   - `VIDEO_WORKER_URL` = the Cloudflare URL printed above
   - `YT_AGENT_WORKER_TOKEN` = the token printed in step 3

6. Redeploy YTAgent if Railway does not automatically redeploy after code changes. Keep the Kaggle notebook session alive while generating.

## Model

Wan 2.1 T2V 1.3B Diffusers: `Wan-AI/Wan2.1-T2V-1.3B-Diffusers`.

Official model code and hardware guidance: https://github.com/Wan-Video/Wan2.1
