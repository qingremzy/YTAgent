# YTAgent free GPU video worker

This worker runs the open Wan 2.1 T2V 1.3B Diffusers model on a temporary Kaggle GPU notebook. Railway handles the YTAgent dashboard, storyboard, narration, editing and YouTube publishing. The notebook connects **outbound** to Railway and polls for work.

## Why this version is better

- No Cloudflare Tunnel.
- No temporary public worker URL.
- No need to update `VIDEO_WORKER_URL` whenever a notebook restarts.
- The worker claims a job from Railway, generates ten real video clips, and securely uploads each MP4 over HTTPS.
- The Railway app validates every uploaded MP4 before assembling the final film.

## Requirements and limits

- Kaggle Notebook with Internet enabled and a GPU accelerator selected.
- Keep the notebook session running while generation is in progress.
- The 1.3B model creates portrait 480p clips. Ten six-second scenes are assembled into one narrated, captioned 60-second Short.
- Ten scenes can take a long time on a free GPU. Kaggle sessions and GPU quota are not guaranteed.
- This is a free-compute starting point, not a promise of Zack D Films-level quality.

## Notebook setup

Open `YTAgent_Free_GPU_Worker.ipynb` in Kaggle. Run the cells in order:

1. Pull the latest repository code and install worker packages.
2. Load the private `YT_AGENT_WORKER_TOKEN` from the existing notebook session or Kaggle Notebook Secrets, then verify the GPU.
3. Start the worker. It will automatically poll YTAgent at `https://ytagent-production-1038.up.railway.app`.

Do not print, commit, or share the worker token. If a fresh notebook session is needed, add `YT_AGENT_WORKER_TOKEN` as a Kaggle Notebook Secret before starting the worker. The same value must already exist as a private Railway variable.

## Model

Wan 2.1 T2V 1.3B Diffusers: `Wan-AI/Wan2.1-T2V-1.3B-Diffusers`.

Official model code and hardware guidance: https://github.com/Wan-Video/Wan2.1

## Troubleshooting

- If the notebook says the token is missing, load the existing Kaggle Secret named `YT_AGENT_WORKER_TOKEN`.
- If no GPU is detected, select a GPU accelerator in Kaggle Notebook settings.
- If the free GPU session disconnects, restart the notebook and run the setup cells again.
- If the worker is running but no job starts, check that YTAgent's private `YT_AGENT_WORKER_TOKEN` matches the Kaggle secret.
- The worker no longer needs `VIDEO_WORKER_URL`, a Cloudflare URL, or a tunnel process.
