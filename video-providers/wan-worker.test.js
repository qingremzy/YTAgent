const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWanScenePrompt, generateWanSceneClips } = require("./wan-worker");
const { claimNextGpuJob, receiveGpuScene, receiveGpuAudio } = require("../gpu-worker-bridge");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("builds a moving cinematic 3D prompt for each storyboard action", () => {
  const prompt = buildWanScenePrompt(
    { visual_direction: "A scientist carefully lifts a glowing glass model" },
    "How cells communicate",
    2
  );
  assert.match(prompt, /stylized 3D animated explainer/);
  assert.match(prompt, /continuous natural movement/);
  assert.match(prompt, /scientist carefully lifts/);
  assert.match(prompt, /vertical mobile viewing/);
  assert.match(prompt, /orbit around the main subject/);
  assert.match(prompt, /Avoid abstract swirls/);
});

test("refuses to contact an unconfigured GPU worker", async () => {
  const oldUrl = process.env.VIDEO_WORKER_URL;
  const oldToken = process.env.YT_AGENT_WORKER_TOKEN;
  const oldMode = process.env.VIDEO_WORKER_MODE;
  delete process.env.VIDEO_WORKER_URL;
  delete process.env.YT_AGENT_WORKER_TOKEN;
  try {
    await assert.rejects(
      generateWanSceneClips(Array.from({ length: 10 }, () => ({ visual_direction: "A detailed scene with visible movement" })), "Test topic", "/tmp"),
      /not configured/
    );
  } finally {
    if (oldUrl === undefined) delete process.env.VIDEO_WORKER_URL;
    else process.env.VIDEO_WORKER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.YT_AGENT_WORKER_TOKEN;
    else process.env.YT_AGENT_WORKER_TOKEN = oldToken;
    if (oldMode === undefined) delete process.env.VIDEO_WORKER_MODE;
    else process.env.VIDEO_WORKER_MODE = oldMode;
  }
});

test("rejects malformed worker URLs before making network requests", async () => {
  const oldUrl = process.env.VIDEO_WORKER_URL;
  const oldToken = process.env.YT_AGENT_WORKER_TOKEN;
  const oldMode = process.env.VIDEO_WORKER_MODE;
  process.env.VIDEO_WORKER_MODE = "tunnel";
  process.env.VIDEO_WORKER_URL = "http://not-secure.example";
  process.env.YT_AGENT_WORKER_TOKEN = "test-token";
  try {
    await assert.rejects(
      generateWanSceneClips(Array.from({ length: 10 }, () => ({ visual_direction: "A detailed scene with visible movement" })), "Test topic", "/tmp"),
      /HTTPS/
    );
  } finally {
    if (oldUrl === undefined) delete process.env.VIDEO_WORKER_URL;
    else process.env.VIDEO_WORKER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.YT_AGENT_WORKER_TOKEN;
    else process.env.YT_AGENT_WORKER_TOKEN = oldToken;
    if (oldMode === undefined) delete process.env.VIDEO_WORKER_MODE;
    else process.env.VIDEO_WORKER_MODE = oldMode;
  }
});

test("uses outbound polling and Kokoro narration without VIDEO_WORKER_URL", async () => {
  const oldUrl = process.env.VIDEO_WORKER_URL;
  const oldToken = process.env.YT_AGENT_WORKER_TOKEN;
  const oldMode = process.env.VIDEO_WORKER_MODE;
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-wan-poll-test-"));
  process.env.YT_AGENT_WORKER_TOKEN = "test-worker-token";
  delete process.env.VIDEO_WORKER_URL;
  delete process.env.VIDEO_WORKER_MODE;
  try {
    const scenes = Array.from({ length: 10 }, (_, i) => ({
      visual_direction: "A detailed 3D character demonstrates a physical action in scene " + i,
      narration: "This is a clear documentary explanation for scene number " + i
    }));
    const resultPromise = generateWanSceneClips(scenes, "How the human heart works", workDir);
    const job = claimNextGpuJob();
    assert.ok(job);
    assert.equal(job.prompts.length, 10);
    assert.equal(job.narrations.length, 10);
    for (let i = 0; i < 10; i++) {
      const mp4 = Buffer.alloc(24000);
      mp4.write("ftyp", 4, "ascii");
      await receiveGpuScene(job.job_id, i, mp4);
    }
    for (let i = 0; i < 10; i++) {
      const wav = Buffer.alloc(4096);
      wav.write("RIFF", 0, "ascii");
      wav.write("WAVE", 8, "ascii");
      await receiveGpuAudio(job.job_id, i, wav);
    }
    const generated = await resultPromise;
    assert.equal(generated.clips.length, 10);
    assert.equal(generated.narrations.length, 10);
  } finally {
    if (oldUrl === undefined) delete process.env.VIDEO_WORKER_URL;
    else process.env.VIDEO_WORKER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.YT_AGENT_WORKER_TOKEN;
    else process.env.YT_AGENT_WORKER_TOKEN = oldToken;
    if (oldMode === undefined) delete process.env.VIDEO_WORKER_MODE;
    else process.env.VIDEO_WORKER_MODE = oldMode;
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
});
