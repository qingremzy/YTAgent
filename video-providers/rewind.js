const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.rewind.ai";
const POLL_INTERVAL_MS = 8000;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

function clean(value, max = 500) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function getJobId(data) {
  return String(data && (data.id || data.job_id || data.jobId) || "");
}

function getVideoUrl(data) {
  const output = data && (data.output || data.result || data.data || data);
  if (!output || typeof output !== "object") return "";
  const urls = Array.isArray(output.urls) ? output.urls : [];
  return String(output.video_url || output.videoUrl || output.url || urls[0] || "");
}

async function apiRequest(route, key, options = {}, timeoutMs = 60000) {
  let response;
  try {
    response = await fetch(API_BASE + route, {
      ...options,
      headers: {
        Authorization: "Bearer " + key,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new Error("Rewind API is unreachable: " + (error.message || "network error"));
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    throw new Error("Rewind API returned HTTP " + response.status + (detail ? ": " + detail : ""));
  }
  return response;
}

async function generateOneScene(scene, topic, index, workDir, key, options = {}) {
  const model = options.model || process.env.REWIND_VIDEO_MODEL || "wan22-ti2v-5b";
  const duration = options.duration || process.env.REWIND_VIDEO_DURATION || "5s";
  const prompt = [
    "Create an original cinematic 3D animated documentary shot in vertical 9:16.",
    "Subject: " + clean(topic, 180) + ".",
    "Action: " + clean(scene.visual_direction, 500) + ".",
    "Show a specific physical subject performing the action in a detailed, believable environment.",
    "Use expressive 3D characters when people are relevant, realistic materials, natural motion, tactile props, cinematic lighting and a moving camera.",
    "Keep the main subject large and clearly visible. Make the shot visually explain the narration rather than show generic decoration.",
    "Avoid abstract swirls, atom diagrams, orbiting dots, floating particles, fractals, glowing wallpaper, static illustrations, text, logos and watermarks.",
    "Original characters and visual identity only."
  ].join(" ");

  const submitted = await apiRequest("/v1/videos/generate-async", key, {
    method: "POST",
    body: JSON.stringify({ model, prompt, duration, aspectRatio: "9:16" })
  });
  const start = await submitted.json().catch(() => ({}));
  const jobId = getJobId(start);
  if (!jobId || !/^[a-z0-9_-]{6,120}$/i.test(jobId)) {
    throw new Error("Rewind accepted the video request but returned an invalid job ID.");
  }

  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let lastState = "";
  while (Date.now() < deadline) {
    const stateResponse = await apiRequest("/v1/jobs/" + encodeURIComponent(jobId), key, {}, 60000);
    const status = await stateResponse.json().catch(() => ({}));
    const state = String(status.status || status.state || "").toUpperCase();
    if (state && state !== lastState) {
      console.log("YTAgent Rewind:", "scene", index + 1, state, status.progress || "");
      lastState = state;
    }
    if (["FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(state)) {
      throw new Error("Rewind video job failed: " + clean(status.error || status.message || state, 400));
    }
    if (["COMPLETED", "SUCCEEDED", "SUCCESS", "DONE"].includes(state)) {
      const videoUrl = getVideoUrl(status);
      if (!videoUrl) throw new Error("Rewind completed the job but returned no video URL.");
      let parsed;
      try { parsed = new URL(videoUrl); } catch (_) { throw new Error("Rewind returned an invalid video URL."); }
      if (parsed.protocol !== "https:") throw new Error("Rewind returned a non-HTTPS video URL.");
      const videoResponse = await fetch(parsed.toString(), { signal: AbortSignal.timeout(120000) });
      if (!videoResponse.ok) throw new Error("Could not download Rewind video (HTTP " + videoResponse.status + ").");
      const bytes = Buffer.from(await videoResponse.arrayBuffer());
      if (bytes.length < 20000 || bytes.subarray(4, 8).toString() !== "ftyp") {
        throw new Error("Rewind returned an invalid or incomplete MP4 for scene " + (index + 1) + ".");
      }
      const destination = path.join(workDir, "rewind-scene-" + String(index + 1).padStart(2, "0") + ".mp4");
      await fs.promises.writeFile(destination, bytes);
      return destination;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("Rewind video generation timed out after 15 minutes for scene " + (index + 1) + ".");
}

async function generateRewindSceneClips(scenes, topic, workDir) {
  const key = process.env.REWIND_API_KEY;
  if (!key) throw new Error("REWIND_API_KEY is not configured.");
  if (!Array.isArray(scenes) || scenes.length !== 10) {
    throw new Error("Rewind video generation requires exactly ten storyboard scenes.");
  }
  if (!workDir) throw new Error("A temporary output directory is required for Rewind video generation.");

  const clips = [];
  for (let index = 0; index < scenes.length; index++) {
    clips.push(await generateOneScene(scenes[index], topic, index, workDir, key));
  }
  return clips;
}

module.exports = { generateRewindSceneClips, generateOneScene, getJobId, getVideoUrl };
