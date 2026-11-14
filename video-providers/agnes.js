const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const BASE_URL = "https://apihub.agnes-ai.com";
const DEFAULT_MODEL = "agnes-video-2.5-flash";
const CLIP_SECONDS = 12;
const HALF_SECONDS = 6;
const SUCCESS_STATUSES = new Set(["completed", "succeeded", "success"]);
const FAILURE_STATUSES = new Set(["failed", "error", "cancelled", "canceled", "rejected"]);
const CINEMATIC_SHOT_DIRECTIONS = Object.freeze([
  "Open with an extreme macro push-in, then rack focus from the foreground detail to the main subject. Use an 85mm cinema prime and shallow depth of field.",
  "Use a smooth lateral tracking move that follows the subject through its environment. Use a 35mm anamorphic lens and layered depth.",
  "Make a controlled orbital move around the subject, revealing its shape and scale. Use a 50mm cinema prime with balanced depth of field.",
  "Begin close, then slowly dolly out to reveal the wider environment and context. Use a 24mm wide-angle cinema lens and deep spatial perspective.",
  "Use a gentle descending crane move that settles into a strong hero composition. Use a 70mm cinema lens with crisp subject separation."
]);

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

function buildCinematicShotDirection(pairIndex = 0) {
  const index = Math.abs(Number(pairIndex) || 0) % CINEMATIC_SHOT_DIRECTIONS.length;
  return CINEMATIC_SHOT_DIRECTIONS[index];
}

function buildPairPrompt(first, second, topic, pairIndex = 0) {
  return [
    "Create one continuous 12-second vertical 9:16 photorealistic LIVE-ACTION documentary video shot, not an illustration or slideshow.",
    "Topic: " + safeText(topic, 180) + ".",
    "FIRST HALF, seconds 0-6: " + safeText(first.visual_direction, 420) + ".",
    "SECOND HALF, seconds 6-12: transition naturally into this new visual action: " + safeText(second.visual_direction, 420) + ".",
    "Make the midpoint transition visually clear through continuous camera movement, not a hard cut.",
    "Camera and lens direction: " + buildCinematicShotDirection(pairIndex),
    "VISUAL PRIORITY: show real human beings on camera whenever the topic allows. Use natural human faces, realistic skin, hands, expressions and body movement. Show people actively doing something relevant: scientists working in a real laboratory, doctors examining models, people reacting, walking, speaking, demonstrating, building or exploring. Use documentary cinematography, authentic locations, practical lighting, natural movement, realistic camera motion and human-scale perspective. Avoid plastic CGI people, game-engine renders, cartoon looks, still-image animation and repeated stock-looking compositions. For invisible science such as cells or atoms, use a brief realistic macro or scientific visualization only when necessary, then return to real people demonstrating or explaining the idea.",
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
  return String(data.status || data.state || "").trim().toLowerCase();
}

function isSuccessfulStatus(status) {
  return SUCCESS_STATUSES.has(String(status || "").toLowerCase());
}

function isFailedStatus(status) {
  return FAILURE_STATUSES.has(String(status || "").toLowerCase());
}

function getGenerationErrorDetail(payload) {
  const data = taskPayload(payload);
  if (typeof data.error === "string") return data.error;
  return data.error?.message || data.error?.detail || data.message || data.detail ||
    "The provider could not generate this scene.";
}

function getVideoUrl(payload) {
  const data = taskPayload(payload);
  const firstOutput = Array.isArray(data.outputs) ? data.outputs[0] : null;
  return data.metadata?.url || data.video_url || data.url ||
    data.output?.url || (typeof firstOutput === "string" ? firstOutput : firstOutput?.url) || "";
}

function getRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== "function") return 0;
  const value = headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Math.max(0, Date.parse(value) - Date.now());
  return Math.min(30000, Math.max(0, milliseconds));
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
    error.retryAfterMs = getRetryAfterMs(response.headers);
    throw error;
  }
  return data;
}

async function createVideoTask(apiKey, model, prompt, seed, seconds = CLIP_SECONDS) {
  return requestJson(BASE_URL + "/v1/videos", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    // Agnes retired the legacy v2.0 width/height/num_frames contract.
    // Current 2.5 Flash uses mode/seconds/size/aspect_ratio.
    body: JSON.stringify({
      model,
      prompt,
      mode: "text",
      seconds: String(seconds),
      size: "720P",
      aspect_ratio: "9:16",
      seed
    })
  }, "Agnes video submission", 60000);
}

async function waitForVideo(apiKey, model, videoId, onProgress) {
  const deadline = Date.now() + 30 * 60 * 1000;
  let waitMs = 60000;
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
      waitMs = Math.min(120000, Math.max(30000, error.retryAfterMs || waitMs));
      continue;
    }
    const status = getTaskStatus(payload);
    const data = taskPayload(payload);
    if (typeof onProgress === "function") onProgress(status, Number(data.progress || 0));
    if (isSuccessfulStatus(status)) {
      const videoUrl = getVideoUrl(payload);
      if (!videoUrl) throw new Error("Agnes marked the scene complete but returned no video URL.");
      return videoUrl;
    }
    if (isFailedStatus(status)) {
      throw new Error("Agnes video generation failed: " + String(getGenerationErrorDetail(payload)).slice(0, 300));
    }
    if (data.error || data.code) {
      const detail = data.error?.message || data.message || data.code;
      if (isQueueFullError({ message: String(detail), providerCode: data.code }) || /rate.?limit|too many/i.test(String(detail))) {
        waitMs = Math.min(120000, waitMs * 2);
      } else {
        throw new Error("Agnes video status error: " + String(detail).slice(0, 260));
      }
    } else {
      waitMs = 60000;
    }
  }
  throw new Error("Agnes video generation timed out after 30 minutes. No incomplete video will be published.");
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

async function generateSceneClips(scenes, topic, workDir, onProgress = () => {}) {
  const apiKey = process.env.AGNES_API_KEY;
  if (!apiKey) {
    throw new Error("The temporary Kaggle worker has been removed. Add AGNES_API_KEY in Railway Variables to connect YTAgent to its hosted video-generation engine.");
  }
  if (!Array.isArray(scenes) || scenes.length !== 10) {
    throw new Error("The Agnes video engine requires exactly ten storyboard scenes.");
  }
  const model = process.env.AGNES_VIDEO_MODEL || DEFAULT_MODEL;
  if (model !== "agnes-video-2.5-flash") {
    throw new Error("YTAgent's zero-cost mode only permits the Agnes Video 2.5 Flash free model.");
  }

  const outputClips = [];
  let lastSubmissionAt = 0;
  for (let pairIndex = 0; pairIndex < 5; pairIndex++) {
    const firstScene = scenes[pairIndex * 2];
    const secondScene = scenes[pairIndex * 2 + 1];
    const elapsed = Date.now() - lastSubmissionAt;
    if (lastSubmissionAt && elapsed < 65000) await delay(65000 - elapsed);

    const prompt = buildPairPrompt(firstScene, secondScene, topic, pairIndex);
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
        const configuredRetries = Number(process.env.AGNES_QUEUE_RETRIES || 2);
        const maxRetries = Number.isInteger(configuredRetries) ? Math.min(3, Math.max(0, configuredRetries)) : 2;
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
    try { onProgress(6 + (pairIndex + 1) * 12, "Generated cinematic video pair " + (pairIndex + 1) + " of 5."); } catch (_) {}
  }
  return outputClips;
}

module.exports = {
  generateSceneClips,
  requestJson,
  buildPairPrompt,
  buildCinematicShotDirection,
  getVideoId,
  getTaskStatus,
  getVideoUrl,
  isSuccessfulStatus,
  isFailedStatus,
  getGenerationErrorDetail,
  getRetryAfterMs,
  isQueueFullError,
  submissionRetryDelay
};
