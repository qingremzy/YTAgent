const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWanScenePrompt, generateWanSceneClips } = require("./wan-worker");

test("builds a moving cinematic 3D prompt for each storyboard action", () => {
  const prompt = buildWanScenePrompt(
    { visual_direction: "A scientist carefully lifts a glowing glass model" },
    "How cells communicate",
    2
  );
  assert.match(prompt, /cinematic 3D animated documentary/);
  assert.match(prompt, /continuous visible motion/);
  assert.match(prompt, /scientist carefully lifts/);
  assert.match(prompt, /vertical mobile video/);
  assert.match(prompt, /orbit around the main subject/);
});

test("refuses to contact an unconfigured GPU worker", async () => {
  const oldUrl = process.env.VIDEO_WORKER_URL;
  const oldToken = process.env.YT_AGENT_WORKER_TOKEN;
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
  }
});

test("rejects malformed worker URLs before making network requests", async () => {
  const oldUrl = process.env.VIDEO_WORKER_URL;
  const oldToken = process.env.YT_AGENT_WORKER_TOKEN;
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
  }
});
