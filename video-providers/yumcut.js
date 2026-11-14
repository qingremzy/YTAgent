"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const API_BASE = "https://app.yumcut.com/api/user/v1";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function enabled(value) {
  return ["true", "1", "yes", "confirmed", "on"].includes(String(value || "").trim().toLowerCase());
}
function clean(value, max = 700) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
async function api(route, key, options = {}, timeoutMs = 60000) {
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
    throw new Error("YumCut API network error: " + (error.message || "request failed"));
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
  if (!response.ok) {
    const detail = data.error?.message || data.message || data.detail || raw.slice(0, 350);
    const error = new Error("YumCut API HTTP " + response.status + ": " + clean(detail || "request failed", 350));
    error.status = response.status;
    throw error;
  }
  return data;
}
function findNumber(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key.toLowerCase()) && Number.isFinite(Number(child))) return Number(child);
  }
  for (const child of Object.values(value)) {
    const found = findNumber(child, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}
function findString(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return "";
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key.toLowerCase()) && typeof child === "string" && child.trim()) return child.trim();
  }
  for (const child of Object.values(value)) {
    const found = findString(child, keys, depth + 1);
    if (found) return found;
  }
  return "";
}
function projectId(data) {
  return findString(data, ["projectid", "project_id", "id"]);
}
function projectStatus(data) {
  return findString(data, ["status", "state"]).toLowerCase();
}
async function download(url, destination) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("YumCut returned a non-HTTPS media URL.");
  const response = await fetch(parsed.toString(), { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error("YumCut video download failed (HTTP " + response.status + ").");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 30000 || bytes.subarray(4, 8).toString() !== "ftyp") throw new Error("YumCut returned an invalid or incomplete MP4.");
  await fs.promises.writeFile(destination, bytes);
}
async function splitFinalVideo(source, workDir) {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable for YumCut scene extraction.");
  const clips = [];
  for (let i = 0; i < 10; i++) {
    const destination = path.join(workDir, "yumcut-scene-" + String(i + 1).padStart(2, "0") + ".mp4");
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(i * 6),
        "-i", source, "-t", "6", "-vf", "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=24,setsar=1",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", destination], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error("YumCut scene extraction failed: " + stderr)));
    });
    const stat = await fs.promises.stat(destination);
    if (stat.size < 12000) throw new Error("YumCut output did not contain a complete 60-second timeline. Scene " + (i + 1) + " was empty.");
    clips.push(destination);
  }
  return clips;
}
function buildYumCutPrompt(scenes, topic) {
  return [
    "Create a complete 60-second vertical 9:16 cinematic animated short film about: " + clean(topic, 180) + ".",
    "This must be a moving film, not a presentation, slideshow, listicle, stock-photo montage, or sequence of still images.",
    "Use coherent 3D animated characters, expressive acting, continuous physical action, believable environments, cinematic camera movement, depth, realistic lighting and consistent character identity.",
    "Each scene must visually enact its supplied physical action. Avoid static poster frames, text cards, diagrams, abstract shapes, orbiting dots, generic stock footage and frozen images.",
    "No opening title card. No end-card. No watermark. Keep all visual storytelling inside the moving scene footage.",
    ...scenes.map((scene, i) => "Scene " + (i + 1) + ": " + clean(scene.visual_direction, 400))
  ].join("\n");
}
async function generateYumCutSceneClips(scenes, topic, workDir, onProgress = () => {}) {
  const key = process.env.YUMCUT_API_KEY;
  const maxTokens = Number(process.env.YUMCUT_MAX_TOKENS_PER_VIDEO || 0);
  if (!enabled(process.env.YUMCUT_FALLBACK_ENABLED) || !enabled(process.env.YUMCUT_COMMERCIAL_USE_APPROVED) ||
      !key || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error("YumCut fallback is disabled. It requires an API key, explicit licence approval, an enabled flag and a positive per-video token cap.");
  }
  if (!Array.isArray(scenes) || scenes.length !== 10) throw new Error("YumCut fallback requires ten storyboard scenes.");
  const prompt = buildYumCutPrompt(scenes, topic);
  const rawScript = scenes.map((scene, i) => "Scene " + (i + 1) + "\nNarration: " + clean(scene.narration, 220) + "\nVisual: " + clean(scene.visual_direction, 400)).join("\n\n");
  const createPayload = {
    prompt,
    rawScript,
    durationSeconds: 60,
    languages: ["en"],
    projectExperience: "story",
    includeDefaultMusic: false,
    addOverlay: false,
    includeCallToAction: false,
    watermarkEnabled: false,
    captionsEnabled: true
  };

  // Quote first and fail closed. Never create a token-costing project if the
  // API does not expose a recognizable cost or it exceeds the configured cap.
  const quote = await api("/project-cost", key, { method: "POST", body: JSON.stringify(createPayload) });
  const cost = findNumber(quote, ["tokencost", "tokensrequired", "requiredtokens", "estimatedtokens", "total tokens", "totalcosttokens", "tokens"]);
  if (cost === null) throw new Error("YumCut cost quote did not expose a recognized token amount. No project was created.");
  if (cost > maxTokens) throw new Error("YumCut quote is " + cost + " tokens, above the configured per-video cap of " + maxTokens + ". No project was created.");
  const balance = await api("/tokens", key);
  const available = findNumber(balance, ["tokenbalance", "balance", "availabletokens", "tokens"]);
  if (available !== null && available < cost) throw new Error("YumCut token balance is below the quoted project cost. No project was created.");

  onProgress(5, "YumCut quote approved within the configured token cap. Creating the video project.");
  const created = await api("/projects", key, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(createPayload)
  });
  const id = projectId(created);
  if (!id || !/^[a-z0-9_-]{4,160}$/i.test(id)) throw new Error("YumCut created no valid project ID.");

  const deadline = Date.now() + 30 * 60 * 1000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await sleep(10000);
    const statusData = await api("/projects/" + encodeURIComponent(id) + "/status", key);
    const status = projectStatus(statusData);
    if (status && status !== lastStatus) {
      onProgress(10, "YumCut project status: " + status + ".");
      lastStatus = status;
    }
    if (["failed", "error", "cancelled", "canceled", "rejected"].includes(status)) {
      throw new Error("YumCut project failed: " + clean(findString(statusData, ["message", "error", "detail"]) || status, 300));
    }
    if (["completed", "complete", "succeeded", "success", "done", "ready"].includes(status)) {
      const media = await api("/projects/" + encodeURIComponent(id) + "/downloads/video", key);
      const url = findString(media, ["downloadurl", "download_url", "videourl", "video_url", "mediaurl", "media_url", "signedurl", "url"]);
      if (!url) throw new Error("YumCut completed but returned no final video download URL.");
      const source = path.join(workDir, "yumcut-final-source.mp4");
      await download(url, source);
      const clips = await splitFinalVideo(source, workDir);
      await fs.promises.unlink(source).catch(() => {});
      return { clips, provider: "YumCut User API", projectId: id, quotedTokenCost: cost };
    }
  }
  throw new Error("YumCut project timed out after 30 minutes.");
}
module.exports = { generateYumCutSceneClips, buildYumCutPrompt, findNumber, findString };
