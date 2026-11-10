# YTAgent

A mobile-friendly YouTube publishing assistant with optional video-aware AI metadata generation.

## Current capabilities

- Connect a YouTube channel through Google OAuth 2.0.
- Upload a video to the connected channel.
- Choose Public, Unlisted or Private visibility (Public is selected by default).
- With a Gemini API key configured, analyse the selected video and generate a relevant title, description, tags, hashtags and a separate social-media caption.
- Generate an SRT subtitle draft when intelligible speech is detected. Review the SRT before using it.
- Review and edit all generated metadata before publishing.

AI-generated metadata and transcripts can contain mistakes. Always review them. No AI tool can guarantee views or virality.

## Requirements

- Node.js 20 or newer.
- A Google Cloud project with YouTube Data API v3 enabled and OAuth 2.0 Web application credentials.
- A Gemini API key for video analysis and metadata generation.

## Environment variables

Copy `.env.example` to `.env` locally, or set the variables in your hosting provider:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `SESSION_SECRET` (use a long random value)
- `GEMINI_API_KEY` (required for AI analysis)
- `GEMINI_MODEL` (optional; selects the Gemini model used for analysis)
- `REDIS_URL` (optional; enables queued background analysis and parallel workers)
- `ANALYSIS_CONCURRENCY` (optional; number of simultaneous analysis jobs in this instance, defaults to 4 and is capped at 50)

Never commit API keys, OAuth secrets, session secrets or user tokens.

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000` and connect your YouTube channel.

## Deploying

Deploy to a Node.js host that supports persistent sessions and long-running uploads. Set all required environment variables in the host dashboard. Set `GOOGLE_REDIRECT_URI` to the production callback URL:

```
https://YOUR-DOMAIN/auth/google/callback
```

Register the exact same redirect URI in Google Cloud Console. Use a persistent session store (such as Redis or a database-backed store) for production multi-instance use.

## Background task processing

When `REDIS_URL` is configured, video analysis is submitted to a BullMQ queue backed by Redis. The app returns a task ID immediately, retries temporary job failures up to three times, and the browser polls for completion. `ANALYSIS_CONCURRENCY` controls simultaneous jobs per running app instance. Without Redis, analysis continues to run synchronously for compatibility.

The queue can hold many waiting tasks, but actual simultaneous work is bounded by worker concurrency and the AI provider's rate limits. This first queue version runs its worker alongside the web server and stores uploaded files on that instance. Horizontal worker scaling requires shared object storage for video files and a separate worker service before increasing replicas.

## Important limitations

- Gemini video analysis requires a valid `GEMINI_API_KEY`; the application does not include or pay for an AI provider key.
- Provider rate limits, file limits, supported video formats and charges depend on the Gemini account and model.
- SRT subtitles are generated as a downloadable draft. This version does not upload subtitle tracks to YouTube automatically.
- Uploaded videos are limited to 256 MB in this starter version.
- YouTube API quota and verification requirements still apply.
- The application does not generate video footage from text yet. It analyses user-supplied video and creates publishing metadata.
