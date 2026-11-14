const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const BASE_URL = process.env.ARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3";
const MODEL = process.env.ARK_VIDEO_MODEL || "dreamina-seedance-2-5-260628";
const PAIR_SECONDS = 12;
const POLL_MS = 10000;
const TASK_TIMEOUT_MS = 20 * 60 * 1000;

function clean(value, max = 500) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function requestJson(url, options = {}, timeoutMs = 60000) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error("BytePlus request failed: " + (error.message || "network error"));
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  if (!response.ok) {
    const detail = data.error?.message || data.message || data.error?.code || raw.slice(0, 300) || ("HTTP " + response.status);
    const error = new Error("BytePlus HTTP " + response.status + ": " + String(detail).slice(0, 400));
    error.status = response.status;
    throw error;
  }
  return data;
}

function buildPrompt(first, second, topic, index) {
  return [
    "Create a coherent, photorealistic live-action documentary video in vertical 9:16 format.",
    "Subject: " + clean(topic, 180) + ".",
    "First half, seconds 0-6: " + clean(first.visual_direction, 400) + ".",
    "Second half, seconds 6-12: transition naturally into: " + clean(second.visual_direction, 400) + ".",
    "Use continuous motivated camera movement and a clear visual transition near the midpoint.",
    "Use realistic people, practical environments, natural lighting, authentic movement and cinematic camera work. Keep the main subject large and readable in a vertical frame.",
    "Maintain continuity of people, wardrobe, props and location across both halves. No titles, subtitles, logos, borders or watermarks.",
    "Camera variation " + (index + 1) + " of 5. Make this shot visually distinct from the other scenes."
  ].join(" ");
}

async function createTask(apiKey, prompt) {
  return requestJson(BASE_URL + "/contents/generations/tasks", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      content: [{ type: "text", text: prompt }],
      generate_audio: false,
      ratio: "9:16",
      duration: PAIR_SECONDS,
      resolution: process.env.ARK_VIDEO_RESOLUTION || "480p",
      watermark: true
    })
  });
}

async function getTask(apiKey, taskId) {
  return requestJson(BASE_URL + "/contents/generations/tasks/" + encodeURIComponent(taskId), {
    headers: { Authorization: "Bearer " + apiKey }
  }, 45000);
}

function unwrap(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload || {};
}

async function waitForTask(apiKey, taskId, pairIndex, onProgress) {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const payload = unwrap(await getTask(apiKey, taskId));
    const status = String(payload.status || payload.state || "").toLowerCase();
    const progress = Number(payload.progress || 0);
    if (onProgress) onProgress(8 + pairIndex * 16 + Math.min(14, progress * 0.14), "Seedance pair " + (pairIndex + 1) + "/5: " + (status || "processing"));
    if (status === "succeeded" || status === "success" || status === "completed") {
      const url = payload.content?.video_url || payload.video_url || payload.output?.video_url;
      if (!url) throw new Error("Seedance completed task " + taskId + " without returning a video URL.");
      return url;
    }
    if (["failed", "error", "cancelled", "canceled", "expired"].includes(status)) {
      const detail = payload.error?.message || payload.error?.detail || payload.message || (status === "expired" ? "ModelArk expired the task before generation completed." : "The Seedance task failed.");
      const code = payload.error?.code ? " [" + String(payload.error.code).slice(0, 80) + "]" : "";
      throw new Error("Seedance task " + status + code + ": " + String(detail).slice(0, 350));
    }
    await wait(POLL_MS);
  }
  throw new Error("Seedance task " + taskId + " exceeded the 20-minute wait limit.");
}

async function downloadMp4(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("Could not download Seedance video (HTTP " + response.status + ").");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 15000 || buffer.toString("ascii", 4, 8) !== "ftyp") {
    throw new Error("Seedance returned a file that did not pass MP4 validation.");
  }
  await fs.promises.writeFile(destination, buffer);
}

function splitClip(source, destination, start) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-y", "-ss", String(start), "-i", source, "-t", "6",
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", destination
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", async code => {
      if (code !== 0) return reject(new Error("Could not split Seedance scene: " + stderr.slice(-500)));
      try {
        const stat = await fs.promises.stat(destination);
        if (stat.size < 15000) throw new Error("Split Seedance scene is unexpectedly small.");
        resolve(destination);
      } catch (error) { reject(error); }
    });
  });
}

async function generateSeedanceSceneClips(scenes, topic, workDir, onProgress = () => {}) {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) throw new Error("ARK_API_KEY is missing from the YTAgent environment.");
  if (!Array.isArray(scenes) || scenes.length !== 10) throw new Error("Seedance requires exactly ten storyboard scenes.");
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable for splitting Seedance clips.");

  const clips = [];
  for (let pair = 0; pair < 5; pair++) {
    const prompt = buildPrompt(scenes[pair * 2], scenes[pair * 2 + 1], topic, pair);
    onProgress(7 + pair * 16, "Submitting Seedance video pair " + (pair + 1) + " of 5.");
    const created = unwrap(await createTask(apiKey, prompt));
    const taskId = created.id || created.task_id;
    if (!taskId) throw new Error("BytePlus accepted no task ID. Check ModelArk model activation and API permissions.");
    const videoUrl = await waitForTask(apiKey, taskId, pair, onProgress);
    const source = path.join(workDir, "seedance-pair-" + (pair + 1) + ".mp4");
    await downloadMp4(videoUrl, source);
    const first = path.join(workDir, "generated-scene-" + (pair * 2) + ".mp4");
    const second = path.join(workDir, "generated-scene-" + (pair * 2 + 1) + ".mp4");
    await splitClip(source, first, 0);
    await splitClip(source, second, 6);
    clips.push(first, second);
    onProgress(8 + (pair + 1) * 16, "Seedance generated cinematic pair " + (pair + 1) + " of 5.");
  }
  return clips;
}

module.exports = { generateSeedanceSceneClips, buildPrompt, requestJson };
