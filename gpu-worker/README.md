# YTAgent free GPU video worker

This worker runs the open Wan 2.1 T2V 1.3B Diffusers model on a temporary Kaggle GPU notebook. Railway handles the YTAgent dashboard, storyboard, narration, editing and YouTube publishing. The notebook connects **outbound** to Railway and polls for work.

## Why this version is better

- No Cloudflare Tunnel.
- No temporary public worker URL.
- No need to update `VIDEO_WORKER_URL` whenever a notebook restarts.
- The worker claims a job from Railway, generates ten real video clips, and securely uploads each MP4 over HTTPS.
- It then creates ten natural male documentary narration tracks locally with Kokoro 82M, without a paid TTS API or Groq rate limits.
- The worker uses OpenCV to sample generated scene frames before upload, rejecting unreadable or almost-entirely-black clips and flagging possible near-static scenes for review.
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

## Regression tests

After installing `gpu-worker/requirements.txt`, run the OpenCV preflight tests from the `gpu-worker` directory:

```bash
python -m unittest -v test_visual_quality.py
```

The tests create tiny temporary videos and verify that unreadable and almost-black clips are rejected, normal moving footage passes, and static footage is flagged without being rejected. They do not download models or consume GPU time.

## Troubleshooting

- If the notebook says the token is missing, load the existing Kaggle Secret named `YT_AGENT_WORKER_TOKEN`.
- If no GPU is detected, select a GPU accelerator in Kaggle Notebook settings.
- If the free GPU session disconnects, restart the notebook and run the setup cells again.
- If the worker is running but no job starts, check that YTAgent's private `YT_AGENT_WORKER_TOKEN` matches the Kaggle secret.
- The worker no longer needs `VIDEO_WORKER_URL`, a Cloudflare URL, or a tunnel process.


### Backup: Google Colab free GPU

Open `YTAgent_Colab_Free_GPU_Worker.ipynb` in Google Colab if you want to use Colab's free GPU instead of waiting for Kaggle. Select a GPU runtime, then add `YT_AGENT_WORKER_TOKEN` to Colab Secrets (key icon) and enable notebook access. The value must match the private token already configured on the Railway YTAgent service.

Run the notebook cells from top to bottom and leave the final worker cell running. It sends an authenticated heartbeat to Railway and waits for one queued film job. Submit the topic from the YTAgent dashboard in another tab. The worker generates ten Wan 2.1 scenes and ten Kokoro narration tracks, then uploads them to Railway automatically. YTAgent assembles and quality-checks the complete MP4. You do not need to stitch clips or upload the video manually.

The Colab worker waits up to 20 minutes for a job. If none arrives, rerun its final cell. It processes one film per run. If the session disconnects, reconnect and rerun the notebook. Colab's free GPU availability and session duration are not guaranteed. Do not purchase compute units or upgrade for this project.

### Kaggle GPU startup diagnostics (November 2026)

The Kaggle push API identifier `NvidiaTeslaT4` requests Kaggle's current free **GPU T4 ×2** pool. Do not change it to guessed identifiers such as `NvidiaTeslaT4x2`. Kaggle staff confirmed the identifier in [kaggle-cli issue #1196](https://github.com/Kaggle/kaggle-cli/issues/1196).

The worker now performs a CUDA preflight immediately after the notebook starts and before installing optional packages. It reports the PyTorch/CUDA build, assigned GPU names, VRAM, and compute capability, and writes `/kaggle/working/ytagent-gpu-preflight.json`. If CUDA is not assigned, it stops before spending time installing dependencies. The CUDA allocator also uses expandable segments to reduce memory fragmentation on shared T4 memory.

**Important:** this improves startup diagnostics and memory allocation after Kaggle assigns a machine. It cannot force Kaggle to allocate a GPU or jump the shared scheduler queue. Kaggle documents that free GPU availability is limited, and recent reports confirm T4 jobs can remain queued for long periods. Repeatedly pushing duplicate versions does not create more GPU capacity and can make diagnosis harder.


### Additional option: Lightning AI free GPU Studio

If Kaggle or Colab cannot allocate a GPU, YTAgent now has a setup guide for running the same outbound-polling Wan worker on Lightning AI. Its free offer advertises up to 80 initial GPU hours without a credit card, subject to phone verification, regional eligibility and available free credits. This is a finite starting grant, not unlimited monthly compute. Follow [`LIGHTNING_AI_SETUP.md`](./LIGHTNING_AI_SETUP.md). The dedicated dependency file preserves Lightning's CUDA-enabled PyTorch build.
