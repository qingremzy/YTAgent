# YTAgent + QingCloud launch checklist

This runbook connects the existing YTAgent server to the QingCloud coordinator and onboards a first safe CPU worker. It does not yet move Wan video inference or FFmpeg rendering onto QingCloud.

## 1. Start a QingCloud coordinator

Run the QingCloud FastAPI service on a host with a persistent SQLite volume. Configure two independent long random secrets:

- `QCLOUD_ENROLLMENT_TOKEN` — shared bootstrap enrollment, optional when using invitations.
- `QCLOUD_ADMIN_TOKEN` — admin API access used by YTAgent.

Keep the SQLite database persistent by setting `QCLOUD_DB_PATH` to the mounted volume. Remote access must use HTTPS. Do not expose the coordinator without authentication or put the admin token in a browser, notebook, or worker.

## 2. Connect YTAgent

Add these server-side environment variables to the YTAgent deployment:

- `QINGCLOUD_URL` — HTTPS base URL of the coordinator.
- `QINGCLOUD_ADMIN_TOKEN` — the coordinator admin token.
- `QINGCLOUD_OWNER_CHANNEL_ID` — the exact YouTube channel ID authorized to manage QingCloud.

Connect the intended YouTube channel to YTAgent, then open `/api/status` in the authenticated browser session and copy its `channelId` value into `QINGCLOUD_OWNER_CHANNEL_ID`. Restart/redeploy YTAgent after changing environment variables.

All YTAgent compute routes verify the connected channel against this owner allowlist before using the server-side coordinator token.

## 3. Enroll a first worker

In the YTAgent QingCloud Compute panel, create a one-time provider invitation. It is displayed once and expires after 24 hours.

On the provider machine, set:

```bash
export QCLOUD_URL="https://YOUR-QINGCLOUD-HOST"
export QCLOUD_INVITATION_TOKEN="ONE-TIME-INVITATION"
python -m worker_agent.agent --once
```

The agent exchanges the invitation for an individual worker token and saves it in `~/.qingcloud/worker.json`. Remove the invitation from the shell environment, then start the worker:

```bash
unset QCLOUD_INVITATION_TOKEN
python -m worker_agent.agent --enable-jobs --interval 60
```

The built-in worker runtime only executes bounded `diagnostic`, `echo`, `sha256`, and `sum_range` tasks. It does not execute arbitrary Python or shell commands.

## 4. Approve and test the worker

Refresh the provider list in YTAgent. A new provider starts as `pending`. Verify its identity and reported hardware, then press **Approve**. Only approved online providers can claim jobs.

Press **Run compute test**. YTAgent submits a 1,000-integer distributed sum with ten chunks. The expected verified total is **500500**. If no eligible worker is online and opted into `--enable-jobs`, the task stays queued.

## 5. What this launch proves

- YTAgent securely reaches the QingCloud coordinator using a server-side admin token.
- The owner-only YTAgent panel can create one-time provider invitations, inspect enrolled providers, and approve/reject them.
- A worker can enroll with a one-time invitation and receives an individual worker token.
- YTAgent can submit and poll a real distributed CPU task tagged `source="ytagent"`.

## Not yet delivered

- Wan 2.1 video generation on QingCloud GPU workers.
- Kokoro narration or FFmpeg rendering on QingCloud.
- Shared media/object storage or cross-worker artifact transfer.
- OS/container sandboxing and hardware-enforced CPU/RAM/VRAM isolation.
- Validation on multiple real physical provider machines.

The current YTAgent Kaggle GPU worker remains its separate video-generation path. Do not describe this control-plane integration as distributed video rendering.
