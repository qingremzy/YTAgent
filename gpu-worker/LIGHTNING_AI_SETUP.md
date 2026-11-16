# Lightning AI free GPU worker (YTAgent)

This is an additional way to run the existing YTAgent Wan 2.1 worker without buying a GPU. It reuses `gpu-worker/app.py` and the existing outbound polling protocol. No new public port, tunnel, or Railway GPU is required.

## What the free offer actually provides

Lightning AI currently advertises **up to 80 free GPU hours to start**, with phone verification and **no credit card required**. The offer is a starting grant, not an unlimited monthly GPU plan. The free account includes one active CPU Studio; GPU usage consumes the included free credits. T4 (16 GB VRAM) and L4 (24 GB) are listed as eligible GPU types with different hour estimates. Availability can vary by country and account. Confirm the displayed free balance before launching a GPU.

Official pricing and signup:
- https://lightning.ai/pricing
- https://platform.lightning.ai/studio

Do not add a payment method or select a paid GPU if the free balance is exhausted. Stop the GPU Studio when not actively rendering.

## Set up

1. Create a free Lightning AI account and complete phone verification.
2. Create a Studio and select a **single NVIDIA T4 (16 GB)** GPU if it is offered within the free balance. An L4 is also suitable if Lightning explicitly shows it covered by the free grant.
3. Open a terminal in the Studio.
4. Clone the YTAgent repository and enter the worker directory:

```bash
git clone https://github.com/qingremzy/YTAgent.git
cd YTAgent/gpu-worker
```

5. Check that the selected Studio really has a CUDA GPU before installing the remaining packages:

```bash
python - <<'PY'
import torch
print("PyTorch:", torch.__version__)
print("CUDA build:", torch.version.cuda)
print("CUDA available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
    print("VRAM GiB:", round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 2))
else:
    raise SystemExit("Stop: this Studio has no usable CUDA GPU. Do not start YTAgent.")
PY
```

6. Keep the CUDA-enabled PyTorch that Lightning supplied. Install the worker's remaining dependencies without replacing PyTorch:

```bash
pip install -r requirements-lightning.txt
```

7. Set the two runtime secrets in the terminal session. Use the exact worker token already configured as `YT_AGENT_WORKER_TOKEN` in the YTAgent Railway service. Never commit it or paste it into GitHub.

```bash
export YT_AGENT_SERVER_URL="https://ytagent-production-1038.up.railway.app"
read -s -p "YTAgent worker token: " YT_AGENT_WORKER_TOKEN
export YT_AGENT_WORKER_TOKEN
echo
```

8. Start the worker:

```bash
python app.py
```

The worker starts its outbound Railway poller, reports heartbeats, claims a queued film, generates Wan 2.1 T2V 1.3B scenes and Kokoro narration, then uploads the media to YTAgent. Keep the Studio running until the job finishes. Do not close the terminal or stop the GPU during a render.

## Important limits

- The free GPU allowance is finite and subject to Lightning's current account and regional eligibility. It is not an always-free production server.
- The existing YTAgent worker uses Wan 2.1 T2V 1.3B with CPU offload. It is designed for a 16 GB T4-class GPU, but speed and memory headroom vary.
- Lightning Studios can restart or stop. A disconnected Studio interrupts an active render.
- The worker currently processes one YTAgent film at a time.
- The free grant does not guarantee enough time to render a full film every day.
- If the GPU option is not explicitly covered by the free balance, do not launch it.

## Troubleshooting

- **CUDA unavailable:** the Studio is CPU-only. Stop and select a GPU Studio; do not proceed with model installation.
- **Worker token rejected:** compare the value with the private Railway `YT_AGENT_WORKER_TOKEN` variable. Do not share either value in chat.
- **No job arrives:** leave the worker running and submit a film from the YTAgent dashboard.
- **GPU credits exhausted:** stop the Studio. Do not add a card or upgrade for this project.

## What this integration is and is not

This uses Lightning AI as another place to host the existing YTAgent GPU worker. It does not make the Railway server itself a GPU server, and it does not turn QingCloud into a video-rendering network. The worker connects outbound to Railway and returns finished scene files over the existing authenticated upload routes.
