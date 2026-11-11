# YTAgent

A mobile-friendly YouTube publishing assistant with narrated AI video generation.

## Capabilities

- Connect a YouTube channel through Google OAuth 2.0 and publish videos.
- Analyse supplied videos and generate YouTube titles, descriptions, tags and hashtags.
- Generate a complete 60-second vertical science film from a topic.
- Generate five 12-second AI video shots, automatically split them into ten timed scenes, then compile one MP4.
- Generate a required AI narrator track for every scene. A missing narrator blocks the render.
- Generate metadata for the finished film.

AI-generated facts and metadata can contain mistakes. Review before publishing. No AI tool can guarantee views or virality.

## Requirements

- Node.js 20 or newer.
- FFmpeg (the deployment includes `ffmpeg-static`).
- Google Cloud project with YouTube Data API v3 and OAuth 2.0 Web application credentials.
- Gemini or Groq API key for AI storyboard generation.
- Agnes AI API key for hosted video generation.

## Environment variables

Set these in the hosting provider. Never commit keys or OAuth secrets.

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `SESSION_SECRET` — long random value.
- `GEMINI_API_KEY` and/or `GROQ_API_KEY` — storyboard generation.
- `AGNES_API_KEY` — optional. Agnes is disabled by default to prevent unexpected charges.
- `AGNES_FREE_QUOTA_CONFIRMED=true` — only enable after verifying in your Agnes account that video generation is currently free and will not charge you. Otherwise YTAgent uses its free FFmpeg visual fallback.
- `AGNES_VIDEO_MODEL` — the zero-cost mode only permits `agnes-video-2.5-flash`. Paid models are blocked.
- `REDIS_URL` — optional. Enables BullMQ background queues. Without it, job records are saved to the app's temporary filesystem and restored after a process restart when that filesystem survives. An interrupted film is marked failed and must be resubmitted.
- `ANALYSIS_CONCURRENCY` — optional analysis worker concurrency.

Agnes Flash has been advertised with a limited-time free promotion, but availability, quotas and pricing can change. To protect against unexpected charges, YTAgent does not call Agnes unless `AGNES_FREE_QUOTA_CONFIRMED=true` is explicitly set, and the paid `agnes-video-2.5` model is blocked. The free FFmpeg visual fallback is used by default.

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
2. Agnes generates five 12-second vertical clips, each describing a pair of consecutive scenes.
3. YTAgent splits each clip into two six-second scene plates.
4. YTAgent generates narration audio for all ten scenes.
5. FFmpeg compiles the ten scene plates and narrator tracks into one 60-second MP4.
6. The render is rejected if narration is missing or the duration check fails.

The pipeline no longer requires a Kaggle notebook, a temporary GPU tunnel, `VIDEO_WORKER_URL` or `YT_AGENT_WORKER_TOKEN`. Generation runs as a background job so the browser does not need to hold one long HTTP request open. With `REDIS_URL`, BullMQ stores generation jobs in Redis and runs one film at a time. Without Redis, YTAgent persists job records to the app's temporary filesystem and restores them after a process restart when that same filesystem is still available. A film interrupted by a restart is marked failed and must be submitted again. Redeploys or replacement instances with ephemeral filesystems can still erase job records and MP4s. Generated MP4s are stored temporarily on the app instance only while the user needs to download them. The download route deletes the MP4 after a successful transfer, with a six-hour expiry as a cleanup safeguard if the user never downloads it. No persistent video volume or paid storage service is required. Temporary files can still disappear if the hosting instance restarts before the download. The hosted video provider has rate limits and may queue or reject requests. A full end-to-end production render has not yet been verified.

## Other limitations

- The current renderer uses scene-level captions, not verified word-by-word captions.
- Background music and sound effects are not yet guaranteed in every render.
- Generated videos are temporary. They are deleted after successful download or automatically expire after six hours. A server restart before download may remove them.
- Long video jobs need a durable background queue before unattended scheduled publishing is enabled.
- YouTube API quota and channel verification requirements still apply.
- Uploaded videos are limited to 256 MB in this starter version.
- Public AI endpoints are limited per IP to two generations and five analyses per hour to reduce accidental or abusive API-quota use. This lightweight in-memory limit resets when the server restarts and is not a substitute for owner authentication.
- External AI analysis calls have request timeouts so an unresponsive optional reviewer cannot hold the analysis workflow indefinitely.
