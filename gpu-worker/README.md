# YTAgent free GPU video worker

This worker runs the open Wan 2.1 T2V 1.3B Diffusers model on a temporary Kaggle GPU notebook. Railway handles the YTAgent dashboard, storyboard, narration, editing and YouTube publishing. The notebook connects **outbound** to Railway and polls for work.

## Why this version is better

- No Cloudflare Tunnel.
- No temporary public worker URL.
- No need to update `VIDEO_WORKER_URL` whenever a notebook restarts.
- The worker claims a job from Railway, generates ten real video clips, and securely uploads each MP4 over HTTPS.
- It then creates ten natural male documentary narration tracks locally with Kokoro 82M, without a paid TTS API or Groq rate limits.
- The Railway app validates every MP4 and WAV before assembling the final film.

## Requirements and limits

- Kaggle Notebook with Internet enabled and a GPU accelerator selected.
- Keep the notebook session running while generation is in progress.
- The 1.3B model creates portrait 480p clips. Ten six-second scenes are assembled into one narrated, captioned 60-second Short.
- Ten scenes can take a long time on a free GPU. Kaggle sessions and GPU quota are not guaranteed.
- Kokoro 82M runs on CPU after video generation to leave GPU memory available for Wan. Its model weights are Apache-2.0 licensed.
- This is a free-compute starting point, not a promise of Zack D Films-level quality.

## Notebook setup

### Primary: Kaggle

Open `YTAgent_Free_GPU_Worker.ipynb` in Kaggle. Run the cells in order:

1. Pull the latest repository code and install worker packages.
2. Load the private `YT_AGENT_WORKER_TOKEN` from the existing notebook session or Kaggle Notebook Secrets, then verify the GPU.
3. Start the worker. It will automatically poll YTAgent at `https://ytagent-production-1038.up.railway.app`.

Do not print, commit, or share the worker token. If a fresh notebook session is needed, add `YT_AGENT_WORKER_TOKEN` as a Kaggle Notebook Secret before starting the worker. The same value must already exist as a private Railway variable.

## Models

- Video: Wan 2.1 T2V 1.3B Diffusers, `Wan-AI/Wan2.1-T2V-1.3B-Diffusers`.
- Narration: Kokoro 82M, `hexgrad/Kokoro-82M`. Default narrator voice is `am_fenrir`. Set `KOKORO_VOICE` to another supported voice if needed.

Official model code and hardware guidance: https://github.com/Wan-Video/Wan2.1
Kokoro model, voice samples and license: https://huggingface.co/hexgrad/Kokoro-82M

## Troubleshooting

- If the notebook says the token is missing, load the existing Kaggle Secret named `YT_AGENT_WORKER_TOKEN`.
- If no GPU is detected, select a GPU accelerator in Kaggle Notebook settings.
- If the free GPU session disconnects, restart the notebook and run the setup cells again.
- If the worker is running but no job starts, check that YTAgent's private `YT_AGENT_WORKER_TOKEN` matches the Kaggle secret.
- The worker no longer needs `VIDEO_WORKER_URL`, a Cloudflare URL, or a tunnel process.


### Backup: Google Colab free GPU

Open `YTAgent_Colab_Free_GPU_Worker.ipynb` in Google Colab if Kaggle has no GPU available. Select a GPU runtime if Colab offers one, then add `YT_AGENT_WORKER_TOKEN` to Colab Secrets (key icon) and allow notebook access. Run the cells in order.

Colab's free GPU is a useful backup, not a guaranteed replacement: hardware, session duration and availability change dynamically. The free tier is intended for interactive notebook use. Do not purchase compute units or upgrade for this project.

## Zero-cost provider policy

YTAgent's default production mode is strict zero-cost:
- Story generation uses only an OpenRouter model ID ending in `:free`.
- Hosted video-generation APIs are not called.
- Hosted text-to-speech fallbacks are disabled. Narration must come from local Kokoro in the GPU worker.
- If a free provider is unavailable or its quota is exhausted, the job stops with an error instead of switching to a paid provider.
- Never add prepaid credits or enable paid fallbacks for YTAgent.
