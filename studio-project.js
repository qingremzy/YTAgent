"use strict";

const fs = require("fs");
const path = require("path");

const PROJECT_ID_RE = /^[a-f0-9]{24}$/i;
const ASSET_RE = /^(?:scene|narration)-(?:0[1-9]|10)\.(?:mp4|wav)$/;

function safeProjectId(value) {
  const id = String(value || "");
  if (!PROJECT_ID_RE.test(id)) throw new Error("Invalid studio project ID.");
  return id.toLowerCase();
}

function buildClipkitSource({ projectId, title, storyboard, sceneAssets }) {
  const id = safeProjectId(projectId);
  if (!Array.isArray(storyboard?.scenes) || storyboard.scenes.length !== 10 ||
      !Array.isArray(sceneAssets) || sceneAssets.length !== 10) {
    throw new Error("An editable YTAgent project requires ten matching scenes.");
  }
  const elements = [];
  for (let index = 0; index < 10; index++) {
    const scene = storyboard.scenes[index];
    const asset = sceneAssets[index];
    if (!scene || !asset?.videoPath || !asset?.narrationPath) {
      throw new Error("Scene " + (index + 1) + " is missing its video or narration asset.");
    }
    const number = String(index + 1).padStart(2, "0");
    const time = index * 6;
    const base = "/api/studio/projects/" + id + "/assets/";
    elements.push({
      id: "scene-" + number,
      name: String(scene.title || scene.caption || ("Scene " + (index + 1))).slice(0, 100),
      type: "video", layer: index + 1, time, duration: 6,
      x: 0, y: 0, width: 540, height: 960, fit: "cover",
      source: base + "scene-" + number + ".mp4",
      volume: 0, playback_rate: 1, loop: false
    });
    elements.push({
      id: "voice-" + number,
      name: "Narration " + (index + 1),
      type: "audio", layer: 101 + index, time, duration: 6,
      source: base + "narration-" + number + ".wav",
      volume: 100
    });
    const caption = String(scene.caption || scene.narration || "").trim().slice(0, 180);
    if (caption) {
      elements.push({
        id: "caption-" + number,
        name: "Caption " + (index + 1),
        type: "text", layer: 201 + index, time: time + 0.15, duration: 5.7,
        x: 270, y: 820, x_anchor: 0.5, y_anchor: 0.5,
        width: 480, height: 120, text: caption,
        font_family: "Inter", font_size: 38, font_weight: 800,
        fill_color: "#ffffff", stroke_color: "#101010", stroke_width: 3,
        text_align: "center"
      });
    }
  }
  return {
    clipkit_version: "1.0",
    output_format: "mp4",
    width: 540,
    height: 960,
    duration: 60,
    frame_rate: 24,
    background_color: "#000000",
    elements
  };
}

async function createStudioProject({ projectId, title, storyboard, sceneAssets, rootDir }) {
  const id = safeProjectId(projectId);
  if (!rootDir) throw new Error("Studio project storage is not configured.");
  const projectDir = path.join(rootDir, id);
  await fs.promises.mkdir(projectDir, { recursive: true });
  try {
    for (let index = 0; index < 10; index++) {
      const number = String(index + 1).padStart(2, "0");
      const asset = sceneAssets[index];
      await Promise.all([
        fs.promises.copyFile(asset.videoPath, path.join(projectDir, "scene-" + number + ".mp4")),
        fs.promises.copyFile(asset.narrationPath, path.join(projectDir, "narration-" + number + ".wav"))
      ]);
    }
    const source = buildClipkitSource({ projectId: id, title, storyboard, sceneAssets });
    const project = {
      id,
      title: String(title || storyboard.title || "YTAgent film").slice(0, 100),
      createdAt: new Date().toISOString(),
      metadata: {
        title: String(storyboard.title || title || "YTAgent film").slice(0, 100),
        description: String(storyboard.description || "").slice(0, 4000),
        keywords: Array.isArray(storyboard.keywords) ? storyboard.keywords.map(String).slice(0, 20) : [],
        tags: Array.isArray(storyboard.tags) ? storyboard.tags.map(String).slice(0, 30) : [],
        hashtags: Array.isArray(storyboard.hashtags) ? storyboard.hashtags.map(String).slice(0, 8) : []
      },
      source
    };
    await fs.promises.writeFile(path.join(projectDir, "project.json"), JSON.stringify(project, null, 2), { mode: 0o600 });
    return { id, title: project.title, createdAt: project.createdAt, source };
  } catch (error) {
    await fs.promises.rm(projectDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function validateStudioSource(source, projectId) {
  const id = safeProjectId(projectId);
  if (!source || typeof source !== "object" || Array.isArray(source) || source.clipkit_version !== "1.0") {
    throw new Error("Studio source must be a Clipkit 1.0 project.");
  }
  if (!Number.isInteger(source.width) || source.width < 1 || source.width > 4096 ||
      !Number.isInteger(source.height) || source.height < 1 || source.height > 4096 ||
      !Number.isFinite(source.duration) || source.duration <= 0 || source.duration > 1800) {
    throw new Error("Studio project dimensions or duration are outside the allowed limits.");
  }
  if (!Array.isArray(source.elements) || source.elements.length < 1 || source.elements.length > 500) {
    throw new Error("Studio project must contain between 1 and 500 timeline elements.");
  }
  const layers = new Set();
  const ids = new Set();
  for (const [index, element] of source.elements.entries()) {
    if (!element || typeof element !== "object" || typeof element.type !== "string" ||
        !Number.isInteger(element.layer) || element.layer < 1 || element.layer > 1000 ||
        layers.has(element.layer)) {
      throw new Error("Studio timeline element " + (index + 1) + " has an invalid or duplicate layer.");
    }
    layers.add(element.layer);
    if (element.id !== undefined) {
      if (typeof element.id !== "string" || !element.id || ids.has(element.id)) {
        throw new Error("Studio timeline element IDs must be unique non-empty strings.");
      }
      ids.add(element.id);
    }
    if (element.time !== undefined && !(
      (typeof element.time === "number" && Number.isFinite(element.time) && element.time >= 0) ||
      (typeof element.time === "string" && element.time.length > 0 && element.time.length <= 32)
    )) {
      throw new Error("Studio timeline element " + (index + 1) + " has an invalid start time.");
    }
    if (element.duration !== undefined && !(
      (typeof element.duration === "number" && Number.isFinite(element.duration) && element.duration > 0) ||
      (typeof element.duration === "string" && element.duration.length > 0 && element.duration.length <= 32)
    )) {
      throw new Error("Studio timeline element " + (index + 1) + " has an invalid duration.");
    }
    if (["image", "video", "audio"].includes(element.type)) {
      const sourcePath = String(element.source || "");
      const prefix = "/api/studio/projects/" + id + "/assets/";
      const filename = sourcePath.startsWith(prefix) ? sourcePath.slice(prefix.length) : "";
      if (!ASSET_RE.test(filename) || filename.includes("/")) {
        throw new Error("Studio media must reference an asset owned by this project.");
      }
    }
  }
  return source;
}

async function saveStudioProject(rootDir, projectId, source) {
  const id = safeProjectId(projectId);
  const validSource = validateStudioSource(source, id);
  const project = await readStudioProject(rootDir, id);
  if (!project) throw new Error("Studio project not found or expired.");
  project.source = validSource;
  project.updatedAt = new Date().toISOString();
  await fs.promises.writeFile(path.join(rootDir, id, "project.json"), JSON.stringify(project, null, 2), { mode: 0o600 });
  return project;
}

async function readStudioProject(rootDir, projectId) {
  const id = safeProjectId(projectId);
  try {
    const raw = await fs.promises.readFile(path.join(rootDir, id, "project.json"), "utf8");
    const project = JSON.parse(raw);
    if (project.id !== id || !project.source || !Array.isArray(project.source.elements)) return null;
    return project;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function resolveStudioAsset(rootDir, projectId, filename) {
  const id = safeProjectId(projectId);
  const name = String(filename || "");
  if (!ASSET_RE.test(name)) throw new Error("Invalid studio asset filename.");
  return path.join(rootDir, id, name);
}

module.exports = {
  safeProjectId,
  buildClipkitSource,
  createStudioProject,
  readStudioProject,
  saveStudioProject,
  validateStudioSource,
  resolveStudioAsset,
  ASSET_RE
};
