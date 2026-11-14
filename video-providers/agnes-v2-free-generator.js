"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const API_BASE = "https://apihub.agnes-ai.com/v1";
const API_ROOT = "https://apihub.agnes-ai.com";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function enabled(value) {
  return ["true", "1", "yes", "confirmed", "on"].includes(String(value || "").trim().toLowerCase());
}
function safe(value, max = 500) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
async function request(url, options = {}, timeoutMs = 60000) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error("Agnes v2.0 fallback network error: " + (error.message || "request failed"));
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  if (!response.ok) {
    const detail = data.error?.message || data.message || data.detail || raw.slice(0, 300);
    const error = new Error("Agnes v2.0 fallback HTTP " + response.status + ": " + String(detail || "request failed").slice(0, 300));
    error.status = response.status;
    throw error;
  }
  return data;
}
function taskId(data) {
  const value = data && (data.video_id || data.task_id || data.id || data.data?.video_id || data.data?.task_id || data.data?.id);
  return String(value || "");
}
function videoUrl(data) {
  const d = data?.data && typeof data.data === "object" ? data.data : data;
  const outputs = Array.isArray(d?.outputs) ? d.outputs : [];
  return String(d?.video_url || d?.url || d?.video?.url || d?.output?.url ||
    (typeof outputs[0] === "string" ? outputs[0] : outputs[0]?.url) || "");
}
async function generateOne(prompt, destination, beatIndex, options = {}) {
  const key = process.env.AGNES_API_KEY;
  if (!enabled(process.env.AGNES_V2_FALLBACK_ENABLED) ||
      !enabled(process.env.AGNES_V2_FREE_QUOTA_CONFIRMED) || !key) {
    throw new Error("Agnes v2.0 Free Video Generator adapter is disabled or not confirmed free.");
  }
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable for Agnes v2.0 normalization.");
  const model = process.env.AGNES_V2_VIDEO_MODEL || "agnes-video-v2.0";
  if (model !== "agnes-video-v2.0") throw new Error("Only the documented Agnes v2.0 free model is allowed in this fallback.");
  const payload = {
    model,
    prompt: safe(prompt, 4500),
    width: 768,
    height: 1152,
    num_frames: 241,
    frame_rate: 24,
    seed: Math.floor(Math.random() * 2000000000)
  };
  const started = await request(API_BASE + "/videos", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const id = taskId(started);
  if (!id || !/^[a-z0-9_-]{4,160}$/i.test(id)) throw new Error("Agnes v2.0 returned no valid video task ID.");

  const deadline = Date.now() + (Number(options.timeoutMs) || 15 * 60 * 1000);
  let waitMs = 30000;
  while (Date.now() < deadline) {
    await sleep(waitMs);
    const status = await request(API_ROOT + "/agnesapi?video_id=" + encodeURIComponent(id), {
      headers: { Authorization: "Bearer " + key }
    }, 30000);
    const state = String(status.status || status.state || "").toLowerCase();
    if (typeof options.onProgress === "function") options.onProgress(beatIndex + 1, state, Number(status.progress || 0));
    if (["completed", "complete", "success", "succeeded", "done"].includes(state)) {
      const url = videoUrl(status);
      if (!url) throw new Error("Agnes v2.0 completed but returned no video URL.");
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new Error("Agnes v2.0 returned a non-HTTPS media URL.");
      const media = await fetch(parsed.toString(), { signal: AbortSignal.timeout(120000) });
      if (!media.ok) throw new Error("Agnes v2.0 media download failed (HTTP " + media.status + ").");
      const bytes = Buffer.from(await media.arrayBuffer());
      if (bytes.length < 20000 || bytes.subarray(4, 8).toString() !== "ftyp") throw new Error("Agnes v2.0 returned an invalid MP4.");
      const source = destination.replace(/\.mp4$/i, "-source.mp4");
      await fs.promises.writeFile(source, bytes);
      await new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-i", source,
          "-t", "10", "-vf", "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=24,setsar=1",
          "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
          "-movflags", "+faststart", destination], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error("Agnes v2.0 FFmpeg normalization failed: " + stderr)));
      });
      await fs.promises.unlink(source).catch(() => {});
      const stat = await fs.promises.stat(destination);
      if (stat.size < 20000) throw new Error("Agnes v2.0 normalized clip failed its file-size check.");
      return destination;
    }
    if (["failed", "error", "cancelled", "canceled"].includes(state)) {
      throw new Error("Agnes v2.0 video generation failed: " + safe(status.error?.message || status.error || status.message || state, 300));
    }
    waitMs = 30000;
  }
  throw new Error("Agnes v2.0 video generation timed out.");
}
async function generateAgnesV2TimelineClips(scenes, topic, workDir, onProgress = () => {}) {
  if (!Array.isArray(scenes) || scenes.length !== 10) throw new Error("Agnes v2.0 fallback requires ten storyboard scenes.");
  const { buildSixBeatPrompts, makeSixSecondTimelineClips } = require("./multi-provider-orchestrator");
  const prompts = buildSixBeatPrompts(scenes, topic);
  const beats = [];
  for (let i = 0; i < prompts.length; i++) {
    onProgress(8 + Math.round(i * 7), "Agnes v2.0 fallback is generating cinematic beat " + (i + 1) + " of 6.");
    const destination = path.join(workDir, "agnes-v2-free-beat-" + (i + 1) + ".mp4");
    beats.push(await generateOne(prompts[i], destination, i, {
      onProgress: (beat, status, percent) => onProgress(8 + Math.round((beat - 1) * 7), "Agnes v2.0 beat " + beat + ": " + (status || "processing") + " " + percent + "%")
    }));
  }
  const clips = await makeSixSecondTimelineClips(beats, workDir);
  return { clips, provider: "Agnes Video v2.0 (Free Video Generator adapter)", beatClips: beats };
}
module.exports = { generateAgnesV2TimelineClips, generateOne, enabled };
