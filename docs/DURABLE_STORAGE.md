# Durable storage setup

YTAgent can run in temporary mode without any extra account. To keep login sessions, background jobs, finished MP4s, and editable scene projects across Railway restarts, configure both a Redis database and an S3-compatible object bucket.

## 1. Upstash Redis (free tier)

Create a Redis database in [Upstash](https://upstash.com/). Choose a region close to the Railway service and copy the native Redis connection string.

Add this Railway variable:

- `REDIS_URL` — the native `rediss://...` connection string. Do not use the Upstash REST URL or REST token.

YTAgent uses this one connection for BullMQ background queues and the Express login-session store. The workers use a 30-second idle drain delay to reduce unnecessary commands.

The Upstash free tier currently lists 256 MB and 500,000 commands per month. That is a limited allowance, not unlimited hosting. Check the [current Upstash pricing](https://upstash.com/pricing/redis) before increasing generation volume.

## 2. Cloudflare R2 (free tier)

Create a **private** R2 bucket in [Cloudflare R2](https://developers.cloudflare.com/r2/). Create an R2 API token with read/write access to that bucket. Do not make the bucket public.

Add these Railway variables:

- `R2_ACCOUNT_ID` — Cloudflare account ID.
- `R2_ACCESS_KEY_ID` — the R2 S3 access key ID.
- `R2_SECRET_ACCESS_KEY` — the matching secret access key.
- `R2_BUCKET_NAME` — the private bucket name.
- `R2_ENDPOINT` — optional. Defaults to `https://<account-id>.r2.cloudflarestorage.com`.

YTAgent uses the S3-compatible API with region `auto`. Finished MP4s and all scene/narration assets are uploaded privately. The app streams them through authenticated YTAgent routes. Local working copies still expire after six hours, while successful R2 copies remain available after a Railway restart.

Cloudflare's free R2 allowance currently lists 10 GB-month storage, 1 million Class A operations, 10 million Class B operations, and no egress charge. Storage and request usage beyond the free allowance may be billed. Review [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and consider a bucket lifecycle rule if you want automatic archival cleanup.

## 3. Confirm durable mode

After adding the variables, redeploy YTAgent and open:

`/health`

Durable mode is ready only when:

- `jobs.redisQueueEnabled` is `true`
- `jobs.sessionStore` is `redis`
- `storage.r2Configured` is `true`
- `durabilityReady` is `true`

If either service is not configured, YTAgent deliberately falls back to its existing temporary mode. Never paste provider secrets into a chat message. Add them directly to Railway's service variables.
