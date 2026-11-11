const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildClipkitSource,
  createStudioProject,
  readStudioProject,
  saveStudioProject,
  validateStudioSource,
  resolveStudioAsset
} = require("./studio-project");

const id = "0123456789abcdef01234567";
function fixtures() {
  const storyboard = {
    title: "A film about deep sea creatures",
    scenes: Array.from({ length: 10 }, (_, i) => ({
      title: "Scene " + (i + 1),
      narration: "Narration for scene " + (i + 1),
      caption: "Caption " + (i + 1)
    }))
  };
  const sceneAssets = Array.from({ length: 10 }, (_, i) => ({
    videoPath: "/tmp/scene-" + i + ".mp4",
    narrationPath: "/tmp/narration-" + i + ".wav"
  }));
  return { storyboard, sceneAssets };
}

test("builds a 60-second Clipkit timeline with ten video and narration pairs", () => {
  const { storyboard, sceneAssets } = fixtures();
  const source = buildClipkitSource({ projectId: id, title: storyboard.title, storyboard, sceneAssets });
  assert.equal(source.clipkit_version, "1.0");
  assert.equal(source.width, 540);
  assert.equal(source.height, 960);
  assert.equal(source.duration, 60);
  assert.equal(source.elements.filter(item => item.type === "video").length, 10);
  assert.equal(source.elements.filter(item => item.type === "audio").length, 10);
  assert.equal(source.elements.filter(item => item.type === "text").length, 10);
  assert.equal(source.elements.find(item => item.id === "scene-02").time, 6);
  assert.equal(source.elements.find(item => item.id === "voice-10").source, "/api/studio/projects/" + id + "/assets/narration-10.wav");
});

test("rejects malformed project IDs and incomplete storyboards", () => {
  const { storyboard, sceneAssets } = fixtures();
  assert.throws(() => buildClipkitSource({ projectId: "../bad", storyboard, sceneAssets }), /Invalid studio project ID/);
  assert.throws(() => buildClipkitSource({ projectId: id, storyboard: { scenes: [] }, sceneAssets }), /ten matching scenes/);
  const source = buildClipkitSource({ projectId: id, storyboard, sceneAssets });
  assert.throws(() => validateStudioSource({ ...source, duration: 5000 }, id), /dimensions or duration/);
  assert.throws(() => validateStudioSource({ ...source, elements: [{ ...source.elements[0], source: "https://evil.example/video.mp4" }] }, id), /must reference an asset owned/);
});

test("copies scene assets and persists a readable project manifest", async () => {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-studio-test-"));
  const inputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-studio-input-"));
  try {
    const { storyboard } = fixtures();
    const sceneAssets = [];
    for (let i = 0; i < 10; i++) {
      const videoPath = path.join(inputDir, "scene-" + i + ".mp4");
      const narrationPath = path.join(inputDir, "narration-" + i + ".wav");
      await fs.promises.writeFile(videoPath, Buffer.from("video-" + i));
      await fs.promises.writeFile(narrationPath, Buffer.from("audio-" + i));
      sceneAssets.push({ videoPath, narrationPath });
    }
    const saved = await createStudioProject({ projectId: id, storyboard, sceneAssets, rootDir });
    const loaded = await readStudioProject(rootDir, id);
    assert.equal(saved.id, id);
    assert.equal(loaded.source.elements.length, 30);
    assert.equal(loaded.metadata.title, storyboard.title);
    assert.deepEqual(loaded.metadata.tags, []);
    assert.equal(await fs.promises.readFile(resolveStudioAsset(rootDir, id, "scene-01.mp4"), "utf8"), "video-0");
    assert.equal(await fs.promises.readFile(resolveStudioAsset(rootDir, id, "narration-10.wav"), "utf8"), "audio-9");
    assert.throws(() => resolveStudioAsset(rootDir, id, "../project.json"), /Invalid studio asset filename/);
    const edited = { ...loaded.source, elements: loaded.source.elements.map(item => item.id === "caption-01" ? { ...item, text: "Edited caption" } : item) };
    validateStudioSource(edited, id);
    const updated = await saveStudioProject(rootDir, id, edited);
    assert.equal(updated.source.elements.find(item => item.id === "caption-01").text, "Edited caption");
    assert.ok(updated.updatedAt);
  } finally {
    await fs.promises.rm(rootDir, { recursive: true, force: true });
    await fs.promises.rm(inputDir, { recursive: true, force: true });
  }
});
