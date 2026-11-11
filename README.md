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
- `AGNES_API_KEY` — required for generated moving video scenes.
- `AGNES_VIDEO_MODEL` — optional. Defaults to `agnes-video-2.5-flash`.
- `REDIS_URL` — optional queue for video analysis.
- `ANALYSIS_CONCURRENCY` — optional analysis worker concurrency.

The Flash video model has been advertised with a limited-time free promotion. Availability, queues, quotas and pricing can change. YTAgent defaults to Flash and does not silently switch to the paid model. The paid `agnes-video-2.5` model is only used when explicitly configured.

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

## Deploying

Use a Node.js host that supports long-running requests and persistent storage. Set `GOOGLE_REDIRECT_URI` to:

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

The pipeline no longer requires a Kaggle notebook, a temporary GPU tunnel, `VIDEO_WORKER_URL` or `YT_AGENT_WORKER_TOKEN`. The hosted video provider still has rate limits and may queue or reject requests. A full end-to-end production render has not yet been verified.

## Other limitations

- The current renderer uses scene-level captions, not verified word-by-word captions.
- Background music and sound effects are not yet guaranteed in every render.
- Generated videos are stored on the running app instance. Persistent object storage is needed for durable downloads across restarts or multiple instances.
- Long video jobs need a durable background queue before unattended scheduled publishing is enabled.
- YouTube API quota and channel verification requirements still apply.
- Uploaded videos are limited to 256 MB in this starter version.
