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
      source
    };
    await fs.promises.writeFile(path.join(projectDir, "project.json"), JSON.stringify(project, null, 2), { mode: 0o600 });
    return { id, title: project.title, createdAt: project.createdAt, source };
  } catch (error) {
    await fs.promises.rm(projectDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
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
  resolveStudioAsset,
  ASSET_RE
};
