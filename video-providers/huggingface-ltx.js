const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const SPACE_BASE_URL = process.env.HF_LTX_SPACE_URL || "https://lightricks-ltx-video-distilled.hf.space";
const API_NAME = "text_to_video";
const REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
const LTX_GPU_SECONDS_PER_CALL = 60;
const LTX_MAX_BEATS_PER_FILM = 2;
const LTX_MIN_QUOTA_SECONDS_PER_FILM = LTX_GPU_SECONDS_PER_CALL * LTX_MAX_BEATS_PER_FILM * 2;

async function getZeroGpuQuota() {
  const token = String(process.env.HF_TOKEN || '').trim();
  if (!token) return { available: false, remaining: null, reason: 'HF_TOKEN is not configured, so authenticated ZeroGPU quota cannot be checked.' };
  let response;
  try {
    response = await fetch('https://huggingface.co/api/spaces/zero-gpu/quota', {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    return { available: false, remaining: null, reason: 'Could not check Hugging Face ZeroGPU quota: ' + (error.message || 'network error') };
  }
  if (!response.ok) return { available: false, remaining: null, reason: 'Hugging Face quota endpoint returned HTTP ' + response.status + '. The token may need Billing > Read billing usage and payment method status permission.' };
  const payload = await response.json().catch(() => ({}));
  const remaining = Number(payload.current ?? payload.remaining);
  if (!Number.isFinite(remaining) || remaining < 0) return { available: false, remaining: null, reason: 'Hugging Face returned an unreadable ZeroGPU quota value.' };
  return {
    available: remaining >= LTX_MIN_QUOTA_SECONDS_PER_FILM,
    remaining,
    base: Number(payload.base) || null,
    resetsAt: payload.resetsAt || null,
    reason: remaining >= LTX_MIN_QUOTA_SECONDS_PER_FILM
      ? 'Enough verified ZeroGPU quota for at most ' + LTX_MAX_BEATS_PER_FILM + ' LTX beats.'
      : 'Only ' + Math.floor(remaining) + ' ZeroGPU seconds remain. This film needs at least ' + LTX_MIN_QUOTA_SECONDS_PER_FILM + ' seconds for its capped LTX fallback.'
  };
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function clean(value, max = 500) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseSseResult(raw) {
  const blocks = String(raw || "").split(/\r?\n\r?\n/).filter(Boolean);
  for (const block of blocks.reverse()) {
    const event = block.match(/^event:\s*(\S+)/m);
    const data = block.match(/^data:\s*(.+)$/m);
    if (!event || !data) continue;
    if (event[1] === "error") {
      let detail = data[1];
      try { detail = JSON.stringify(JSON.parse(data[1])); } catch (_) {}
      if (!detail || detail === "null" || detail === '""') {
        throw new Error("LTX public ZeroGPU queue rejected the request with an empty error event. The shared Space may be out of GPU capacity or temporarily unavailable.");
      }
      throw new Error("LTX Space generation failed: " + String(detail).slice(0, 300));
    }
    if (event[1] === "complete") {
      let payload;
      try { payload = JSON.parse(data[1]); } catch (_) { throw new Error("LTX Space returned malformed completion data."); }
      const videoField = Array.isArray(payload) ? payload[0] : payload;
      const fileField = Array.isArray(videoField) ? videoField[0] : videoField;
      const videoUrl = fileField?.video?.url || fileField?.url || fileField?.video_url ||
        fileField?.path || fileField?.video?.path;
      if (!videoUrl) throw new Error("LTX Space completed without a downloadable video file. Response shape: " + JSON.stringify(payload).slice(0, 260));
      return videoUrl;
    }
  }
  throw new Error("LTX Space closed the stream without a completed video.");
}

async function generateOne(prompt, seed) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.HF_TOKEN) headers.Authorization = "Bearer " + process.env.HF_TOKEN;
  const data = [
    clean(prompt, 1800),
    "worst quality, blurry, distorted, watermark, text, subtitles",
    "",
    "",
    640,
    384,
    "text-to-video",
    5,
    9,
    seed,
    true,
    1,
    false
  ];
  let response;
  try {
    response = await fetch(SPACE_BASE_URL + "/gradio_api/call/" + API_NAME, {
      method: "POST", headers, body: JSON.stringify({ data }),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw new Error("Could not reach the public LTX Space: " + (error.message || "network error"));
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 240);
    throw new Error("LTX Space submission returned HTTP " + response.status + (detail ? ": " + detail : ""));
  }
  const submitted = await response.json().catch(() => ({}));
  const eventId = String(submitted.event_id || "");
  if (!eventId) throw new Error("LTX Space did not return a queue event ID.");

  let result;
  try {
    result = await fetch(SPACE_BASE_URL + "/gradio_api/call/" + API_NAME + "/" + encodeURIComponent(eventId), {
      headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error("LTX Space generation timed out or disconnected: " + (error.message || "network error"));
  }
  if (!result.ok || !result.body) {
    throw new Error("LTX Space result stream failed with HTTP " + result.status + ".");
  }
  return parseSseResult(await result.text());
}

async function downloadAndNormalize(url, destination, durationSeconds = 6) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error("LTX Space returned an invalid video URL."); }
  if (parsed.protocol !== "https:") throw new Error("LTX Space returned a non-HTTPS video URL.");
  const response = await fetch(parsed.toString(), { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error("Could not download LTX video (HTTP " + response.status + ").");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 15000 || bytes.toString("ascii", 4, 8) !== "ftyp") {
    throw new Error("LTX Space returned an invalid or incomplete MP4.");
  }
  const source = destination.replace(/\.mp4$/i, "-source.mp4");
  await fs.promises.writeFile(source, bytes);
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", source, "-t", String(durationSeconds),
      "-vf", "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30,setsar=1",
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", destination
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("Could not normalize LTX MP4: " + stderr.slice(-500))));
  });
  await fs.promises.unlink(source).catch(() => {});
  const stat = await fs.promises.stat(destination);
  if (stat.size < 15000) throw new Error("LTX normalized scene did not pass its MP4 size check.");
}

function buildPrompt(scene, topic, index) {
  return [
    "Create a cinematic vertical 9:16 live-action documentary shot for a YouTube explainer.",
    "Topic: " + clean(topic, 180) + ".",
    "Shot " + (index + 1) + " of 10: " + clean(scene.visual_direction, 450) + ".",
    "Show the real subject performing a clear physical action in a recognizable environment. Natural human movement, believable objects, coherent anatomy, realistic lighting, detailed camera work, continuous motion throughout.",
    "No text, captions, logos, watermarks, borders, diagrams, abstract shapes or still-image slideshow."
  ].join(" ");
}

async function generateLtxSceneClips(scenes, topic, workDir, onProgress = () => {}) {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable for the public LTX fallback.");
  if (!Array.isArray(scenes) || scenes.length !== 10) throw new Error("LTX fallback requires exactly ten storyboard scenes.");
  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const prompt = buildPrompt(scenes[i], topic, i);
    const seed = Math.floor(Math.random() * 2147483647);
    const url = await generateOne(prompt, seed);
    const destination = path.join(workDir, "ltx-scene-" + String(i + 1).padStart(2, "0") + ".mp4");
    await downloadAndNormalize(url, destination);
    clips.push(destination);
    try { onProgress(7 + (i + 1) * 2, "Public LTX video scene " + (i + 1) + " of 10 generated."); } catch (_) {}
    if (i < scenes.length - 1) await delay(1500);
  }
  return clips;
}


async function generateLtxFiveSecondShot(prompt, destination, seed) {
  const url = await generateOne(prompt, seed);
  await downloadAndNormalize(url, destination, 5);
  return destination;
}

module.exports = { generateLtxSceneClips, generateLtxFiveSecondShot, parseSseResult, buildPrompt, getZeroGpuQuota, LTX_GPU_SECONDS_PER_CALL, LTX_MAX_BEATS_PER_FILM, LTX_MIN_QUOTA_SECONDS_PER_FILM };
