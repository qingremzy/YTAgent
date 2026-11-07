# YTAgent

A simple, mobile-friendly YouTube upload assistant. It connects to your own YouTube channel through Google's OAuth 2.0 flow and uploads a video using the YouTube Data API. It is a separate tool and does not replace ChatGPT.

## What works in this starter

- Connect and authorize a YouTube channel.
- Check whether the channel is connected.
- Upload a video with title, description, tags, and privacy setting.
- Use a simple command box such as "post my new video" to open the upload workflow.
- Mobile-friendly web interface.

## Requirements

- Node.js 20 or newer.
- A Google Cloud project with the **YouTube Data API v3** enabled.
- OAuth 2.0 credentials for a **Web application**.

## Google OAuth setup

1. Open Google Cloud Console and select or create your project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen. Add your Google account as a test user if the app is still in testing.
4. Create an OAuth client ID with application type **Web application**.
5. Add this exact authorized redirect URI for local testing: `http://localhost:3000/auth/google/callback`.
6. Copy the client ID and client secret into your local `.env` file. Never commit secrets or share them in public messages.

## Run locally

```bash
npm install
cp .env.example .env
```

Edit `.env` and set your Google credentials plus a long random SESSION_SECRET. Then run:

```bash
npm start
```

Open `http://localhost:3000` in your browser and tap **Connect YouTube**.

On Windows, you can copy `.env.example` to `.env` manually if `cp` is unavailable.

## Deploying

Deploy the project to a Node.js host that supports persistent sessions and long-running uploads. Set the environment variables from `.env.example` in the host dashboard. Set `APP_URL` to your HTTPS deployment URL and set `GOOGLE_REDIRECT_URI` to:

```
https://YOUR-DOMAIN/auth/google/callback
```

Add that same HTTPS URL to the OAuth client's authorized redirect URIs in Google Cloud Console. Use HTTPS in production. For production use, replace Express's in-memory session store with a persistent session store such as Redis or a database-backed store.

## Important notes

- This repository contains no Google credentials or access tokens.
- The starter defaults uploads to **Private**. Choose Unlisted or Public only when you intend to.
- YouTube API projects may be subject to quota limits and Google verification or audit requirements. A successful code deployment does not by itself guarantee public uploads.
- This starter limits each uploaded file to 256 MB. Large uploads may need a larger server timeout and resumable upload handling.
- Do not expose your OAuth client secret, session secret, or user tokens in screenshots, source code, or public repositories.
- The quick command is a small helper that opens the upload flow. It is not yet a full natural-language AI agent or a scheduled uploader.
