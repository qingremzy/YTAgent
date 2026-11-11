const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const BASE_URL = "https://apihub.agnes-ai.com";
const DEFAULT_MODEL = "agnes-video-2.5-flash";
const CLIP_SECONDS = 12;
const HALF_SECONDS = 6;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isQueueFullError(error) {
  const message = String(error && error.message || "");
  const code = String(error && error.providerCode || "");
  return /queue\s+is\s+full|queue[ _-]*full|full[ _-]*queue|queue.{0,30}capacity|capacity.{0,30}queue/i.test(message + " " + code);
}

function submissionRetryDelay(attempt) {
  return Math.min(5 * 60 * 1000, 60 * 1000 * Math.pow(2, Math.max(0, attempt - 1)));
}

function safeText(value, max = 700) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function buildPairPrompt(first, second, topic) {
  return [
    "Create one continuous 12-second vertical 9:16 cinematic science documentary CGI shot.",
    "Topic: " + safeText(topic, 180) + ".",
    "FIRST HALF, seconds 0-6: " + safeText(first.visual_direction, 420) + ".",
    "SECOND HALF, seconds 6-12: transition naturally into this new visual action: " + safeText(second.visual_direction, 420) + ".",
    "Make the midpoint transition visually clear through continuous camera movement, not a hard cut.",
    "Premium photorealistic 3D CGI, physically plausible materials and motion, scientifically believable anatomy and scale, dramatic volumetric lighting, atmospheric depth, rich macro detail, smooth deliberate camera movement.",
    "Keep the main subject large and centered for a 9:16 frame. No text, captions, labels, logos, watermarks, borders or split screens."
  ].join(" ");
}

function taskPayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  return payload.data && typeof payload.data === "object" ? payload.data : payload;
}

function getVideoId(payload) {
  const data = taskPayload(payload);
  return data.video_id || data.task_id || data.id || "";
}

function getTaskStatus(payload) {
  const data = taskPayload(payload);
  return String(data.status || data.state || "").toLowerCase();
}

function getVideoUrl(payload) {
  const data = taskPayload(payload);
  return data.metadata?.url || data.video_url || data.url || "";
}

async function requestJson(url, options, label, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs || 60000) });
  } catch (error) {
    throw new Error(label + " network request failed: " + (error.message || "fetch failed"));
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {
    const detail = raw.trim().slice(0, 300) || "The provider returned an empty response.";
    const error = new Error(response.ok
      ? label + " returned an invalid response (HTTP " + response.status + "): " + detail
      : label + " failed: " + detail);
    error.status = response.status;
    error.providerCode = detail;
    throw error;
  }
  if (!response.ok) {
    const detail = data.error?.message || data.error?.detail || data.message || data.detail || raw.trim().slice(0, 300) || "HTTP " + response.status;
    const error = new Error(label + " failed: " + String(detail).slice(0, 300));
    error.status = response.status;
    error.providerCode = data.error?.code || data.code || detail;
    throw error;
  }
  return data;
}

async function createVideoTask(apiKey, model, prompt, seed) {
  return requestJson(BASE_URL + "/v1/videos", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      prompt,
      mode: "text",
      seconds: String(CLIP_SECONDS),
      size: "720P",
      aspect_ratio: "9:16",
      seed
    })
  }, "Agnes video submission", 60000);
}

async function waitForVideo(apiKey, model, videoId, onProgress) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let waitMs = 12000;
  while (Date.now() < deadline) {
    await delay(waitMs);
    const url = BASE_URL + "/agnesapi?video_id=" + encodeURIComponent(videoId) +
      "&model_name=" + encodeURIComponent(model);
    let payload;
    try {
      payload = await requestJson(url, {
        headers: { Authorization: "Bearer " + apiKey }
      }, "Agnes video status check", 30000);
    } catch (error) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(error.status) ||
        isQueueFullError(error) ||
        /rate.?limit|too many|temporarily unavailable|network request failed|fetch failed|timeout/i.test(error.message);
      if (!retryable) throw error;
      waitMs = Math.min(30000, Math.max(12000, waitMs * 2));
      continue;
    }
    const status = getTaskStatus(payload);
    const data = taskPayload(payload);
    if (typeof onProgress === "function") onProgress(status, Number(data.progress || 0));
    if (status === "completed") {
      const videoUrl = getVideoUrl(payload);
      if (!videoUrl) throw new Error("Agnes marked the scene complete but returned no video URL.");
      return videoUrl;
    }
    if (status === "failed") {
      const detail = data.error?.message || data.error?.detail || data.message || "The provider could not generate this scene.";
      throw new Error("Agnes video generation failed: " + String(detail).slice(0, 300));
    }
    if (data.error || data.code) {
      const detail = data.error?.message || data.message || data.code;
      if (isQueueFullError({ message: String(detail), providerCode: data.code }) || /rate.?limit|too many/i.test(String(detail))) {
        waitMs = Math.min(30000, waitMs * 2);
      } else {
        throw new Error("Agnes video status error: " + String(detail).slice(0, 260));
      }
    } else {
      waitMs = 10000;
    }
  }
  throw new Error("Agnes video generation timed out after 15 minutes. No incomplete video will be published.");
}

async function downloadVideo(url, destination) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error("Agnes returned an invalid video URL."); }
  if (parsed.protocol !== "https:") throw new Error("Agnes returned an insecure video URL.");
  let response;
  try {
    // The provider returns a signed CDN URL. Never forward the Agnes API key to that host.
    response = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(120000)
    });
  } catch (error) {
    throw new Error("Could not download the generated scene: " + (error.message || "network error"));
  }
  if (!response.ok) throw new Error("Could not download the generated scene (HTTP " + response.status + ").");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 20000) throw new Error("Agnes returned an empty or incomplete video file.");
  await fs.promises.writeFile(destination, bytes);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => code === 0
      ? resolve()
      : reject(new Error("Could not prepare generated scene clips: " + stderr.slice(-900))));
  });
}

async function splitIntoShots(source, firstPath, secondPath) {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable on this server.");
  const filter = "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30,setsar=1";
  for (const item of [
    { start: "0", output: firstPath },
    { start: "6", output: secondPath }
  ]) {
    await runFfmpeg([
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", item.start, "-i", source, "-t", String(HALF_SECONDS),
      "-an", "-vf", filter, "-c:v", "libx264", "-preset", "veryfast",
      "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", item.output
    ]);
    const stat = await fs.promises.stat(item.output);
    if (stat.size < 15000) throw new Error("A generated six-second scene failed its file check.");
  }
}

async function generateSceneClips(scenes, topic, workDir) {
  const apiKey = process.env.AGNES_API_KEY;
  if (!apiKey) {
    throw new Error("The temporary Kaggle worker has been removed. Add AGNES_API_KEY in Railway Variables to connect YTAgent to its hosted video-generation engine.");
  }
  if (!Array.isArray(scenes) || scenes.length !== 10) {
    throw new Error("The Agnes video engine requires exactly ten storyboard scenes.");
  }
  const model = process.env.AGNES_VIDEO_MODEL || DEFAULT_MODEL;
  if (!["agnes-video-2.5-flash", "agnes-video-2.5"].includes(model)) {
    throw new Error("Unsupported Agnes video model. Use agnes-video-2.5-flash or agnes-video-2.5.");
  }
  if (model === "agnes-video-2.5") {
    console.warn("Agnes Video 2.5 is a paid model. Each generated second may incur charges.");
  }

  const outputClips = [];
  let lastSubmissionAt = 0;
  for (let pairIndex = 0; pairIndex < 5; pairIndex++) {
    const firstScene = scenes[pairIndex * 2];
    const secondScene = scenes[pairIndex * 2 + 1];
    const elapsed = Date.now() - lastSubmissionAt;
    if (lastSubmissionAt && elapsed < 65000) await delay(65000 - elapsed);

    const prompt = buildPairPrompt(firstScene, secondScene, topic);
    let started;
    let attempts = 0;
    while (true) {
      try {
        started = await createVideoTask(apiKey, model, prompt, Math.floor(Math.random() * 2000000000));
        break;
      } catch (error) {
        const queueFull = isQueueFullError(error);
        const retryable = queueFull || [408, 429, 500, 502, 503, 504].includes(error.status) ||
          /temporarily unavailable|rate.?limit|too many requests|network request failed|fetch failed|timeout/i.test(error.message);
        // Queue-full responses are transient. Wait with exponential backoff for up to
        // six retries rather than failing the entire film after two short waits.
        const maxRetries = 6;
        if (!retryable || attempts >= maxRetries) {
          if (queueFull) {
            throw new Error("Agnes video queue remained full after " + (attempts + 1) +
              " submission attempts. YTAgent waited and retried automatically. Please try again later.");
          }
          throw error;
        }
        attempts++;
        const waitMs = submissionRetryDelay(attempts);
        console.warn("Agnes queue/rate limit on scene pair " + (pairIndex + 1) +
          "/5. Retry " + attempts + "/" + maxRetries + " in " + Math.round(waitMs / 1000) + " seconds.");
        await delay(waitMs);
      }
    }
    lastSubmissionAt = Date.now();
    const videoId = getVideoId(started);
    if (!videoId) throw new Error("Agnes accepted the request but returned no video task ID.");

    const videoUrl = await waitForVideo(apiKey, model, videoId, (status, progress) => {
      console.log("YTAgent scene pair " + (pairIndex + 1) + "/5:", status || "waiting", progress + "%");
    });
    const source = path.join(workDir, "agnes-pair-" + (pairIndex + 1) + ".mp4");
    await downloadVideo(videoUrl, source);

    const firstPath = path.join(workDir, "generated-scene-" + (pairIndex * 2) + ".mp4");
    const secondPath = path.join(workDir, "generated-scene-" + (pairIndex * 2 + 1) + ".mp4");
    await splitIntoShots(source, firstPath, secondPath);
    outputClips.push(firstPath, secondPath);
  }
  return outputClips;
}

module.exports = {
  generateSceneClips,
  requestJson,
  buildPairPrompt,
  getVideoId,
  getTaskStatus,
  getVideoUrl,
  isQueueFullError,
  submissionRetryDelay
};
