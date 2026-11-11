# YTAgent

A mobile-friendly YouTube publishing assistant with narrated AI video generation.

## Capabilities

- Connect a YouTube channel through Google OAuth 2.0 and publish videos.
- Analyse supplied videos and generate YouTube titles, descriptions, tags and hashtags.
- Generate a complete 60-second vertical documentary-style film from a topic.
- Generate ten genuine AI-animated scenes with Wan 2.1 on a free Kaggle GPU.
- Generate ten natural documentary narration tracks locally with Kokoro 82M, avoiding paid TTS APIs and Groq rate limits.
- Compile one MP4 with scene-matched captions, narration and quality checks.
- Provide a real-time Three.js 3D studio interface with interactive camera controls.
- Generate metadata for the finished film.

AI-generated facts and metadata can contain mistakes. Review before publishing. No AI tool can guarantee views or virality.

## Requirements

- Node.js 20 or newer.
- FFmpeg (the deployment includes `ffmpeg-static`).
- Google Cloud project with YouTube Data API v3 and OAuth 2.0 Web application credentials.
- Gemini or Groq API key for AI storyboard generation.
- Optional free Kaggle GPU notebook for Wan 2.1 video generation and Kokoro narration. See [GPU worker setup](gpu-worker/README.md).
- Optional Agnes API key only if a verified no-charge quota is available.

## Environment variables

Set these in the hosting provider. Never commit keys or OAuth secrets.

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `SESSION_SECRET` — long random value.
- `GEMINI_API_KEY` and/or `GROQ_API_KEY` — storyboard generation.
- `YT_AGENT_WORKER_TOKEN` — private shared secret configured in Railway and stored as a Kaggle Notebook Secret. The worker polls Railway outbound over HTTPS. No `VIDEO_WORKER_URL` or Cloudflare Tunnel is required.
- `AGNES_API_KEY` — optional. Agnes is disabled by default to prevent unexpected charges.
- `AGNES_FREE_QUOTA_CONFIRMED=true` — only enable after verifying in your Agnes account that video generation is currently free and will not charge you. If no real-video provider is available, YTAgent stops and reports the error rather than returning abstract artwork.
- `AGNES_VIDEO_MODEL` — the zero-cost mode only permits `agnes-video-2.5-flash`. Paid models are blocked.
- `REDIS_URL` — optional. Enables BullMQ background queues. Without it, job records are saved to the app's temporary filesystem and restored after a process restart when that filesystem survives. An interrupted film is marked failed and must be resubmitted.
- `ANALYSIS_CONCURRENCY` — optional analysis worker concurrency.

YTAgent uses the outbound-polling Wan 2.1 free GPU worker when its private worker token is configured. The Kaggle notebook must remain active during generation, and free GPU availability is not guaranteed. Agnes is only attempted when `AGNES_FREE_QUOTA_CONFIRMED=true` is explicitly set. YTAgent does not substitute abstract animated artwork when genuine video generation fails.

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

## Deploying

Use a Node.js host that supports long-running requests. Set `GOOGLE_REDIRECT_URI` to:

```
https://YOUR-DOMAIN/auth/google/callback
```

Register the exact same redirect URI in Google Cloud Console. Use a persistent session store for production multi-instance use.

## Video generation pipeline

1. The AI director creates a ten-scene storyboard with narration.
2. The Kaggle worker polls Railway outbound and claims the job. No inbound tunnel is used.
3. Wan 2.1 generates ten portrait AI-video scenes.
4. Kokoro 82M generates ten documentary narration tracks locally on CPU.
5. The worker uploads the MP4 and WAV files to Railway over authenticated HTTPS.
6. FFmpeg adds captions, narration and assembles one 60-second MP4.
7. The render is rejected if any narration is missing, the MP4 fails decoding, or the duration check fails.

Generation runs as a background job so the browser does not need to hold one long HTTP request open. The free GPU notebook must remain active during Wan generation. Its outbound HTTPS polling connection automatically reconnects after network interruptions. No tunnel URL needs to be copied or refreshed. With `REDIS_URL`, BullMQ stores generation jobs in Redis. Without Redis, YTAgent uses its app instance's temporary filesystem. Generated MP4s are temporary and are deleted after successful download, with a six-hour cleanup safeguard. A server restart can still erase job records or video files before download. No paid storage or Redis service is required for the basic flow. A full end-to-end production render still needs to be tested on the deployed Railway app with the free GPU notebook connected.

## Other limitations

- The current renderer uses scene-level captions, not verified word-by-word captions.
- Background music and sound effects are not yet guaranteed in every render.
- Generated videos are temporary. They are deleted after successful download or automatically expire after six hours. A server restart before download may remove them.
- Long video jobs need a durable background queue before unattended scheduled publishing is enabled.
- YouTube API quota and channel verification requirements still apply.
- Uploaded videos are limited to 256 MB in this starter version.
- Public AI endpoints are limited per IP to two generations and five analyses per hour to reduce accidental or abusive API-quota use. This lightweight in-memory limit resets when the server restarts and is not a substitute for owner authentication.
- External AI analysis calls have request timeouts so an unresponsive optional reviewer cannot hold the analysis workflow indefinitely.
