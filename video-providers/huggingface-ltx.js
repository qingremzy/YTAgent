const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const SPACE_BASE_URL = process.env.HF_LTX_SPACE_URL || "https://lightricks-ltx-video-distilled.hf.space";
const API_NAME = "text_to_video";
const REQUEST_TIMEOUT_MS = 4 * 60 * 1000;

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
    if (event[1] === "error") throw new Error("LTX Space generation failed: " + data[1].slice(0, 300));
    if (event[1] === "complete") {
      let payload;
      try { payload = JSON.parse(data[1]); } catch (_) { throw new Error("LTX Space returned malformed completion data."); }
      const videoField = Array.isArray(payload) ? payload[0] : payload;
      const videoUrl = videoField?.video?.url || videoField?.url || videoField?.video_url;
      if (!videoUrl) throw new Error("LTX Space completed without returning a video URL.");
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
    896,
    512,
    "text-to-video",
    6,
    9,
    seed,
    true,
    1,
    true
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

async function downloadAndNormalize(url, destination) {
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
      "-y", "-hide_banner", "-loglevel", "error", "-i", source, "-t", "6",
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

module.exports = { generateLtxSceneClips, parseSseResult, buildPrompt };
