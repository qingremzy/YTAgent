const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPairPrompt,
  generateSceneClips,
  getVideoId,
  getTaskStatus,
  getVideoUrl,
  isQueueFullError,
  submissionRetryDelay
} = require("./agnes");

test("builds one vertical paired-scene prompt with a midpoint transition", () => {
  const prompt = buildPairPrompt(
    { visual_direction: "A red blood cell travels through a vessel" },
    { visual_direction: "The cell releases oxygen near muscle tissue" },
    "How blood works"
  );
  assert.match(prompt, /0-6/);
  assert.match(prompt, /6-12/);
  assert.match(prompt, /9:16/);
  assert.match(prompt, /red blood cell/);
  assert.match(prompt, /releases oxygen/);
});

test("reads Agnes task IDs from supported response shapes", () => {
  assert.equal(getVideoId({ video_id: "video-1" }), "video-1");
  assert.equal(getVideoId({ data: { task_id: "task-2" } }), "task-2");
  assert.equal(getVideoId({ id: "id-3" }), "id-3");
});

test("normalizes task status and generated video URL", () => {
  assert.equal(getTaskStatus({ data: { status: "COMPLETED" } }), "completed");
  assert.equal(getVideoUrl({ metadata: { url: "https://cdn.example/video.mp4" } }), "https://cdn.example/video.mp4");
});

test("recognizes Agnes queue-full messages", () => {
  assert.equal(isQueueFullError({ message: "video queue is full, please retry later" }), true);
  assert.equal(isQueueFullError({ message: "QUEUE_FULL" }), true);
  assert.equal(isQueueFullError({ message: "invalid API key" }), false);
});

test("uses increasing capped delays for queue retries", () => {
  assert.equal(submissionRetryDelay(1), 60000);
  assert.equal(submissionRetryDelay(2), 120000);
  assert.equal(submissionRetryDelay(3), 240000);
  assert.equal(submissionRetryDelay(6), 300000);
});

test("blocks the paid Agnes model in zero-cost mode", async () => {
  const oldKey = process.env.AGNES_API_KEY;
  const oldModel = process.env.AGNES_VIDEO_MODEL;
  process.env.AGNES_API_KEY = "test-key";
  process.env.AGNES_VIDEO_MODEL = "agnes-video-2.5";
  try {
    await assert.rejects(
      generateSceneClips(Array.from({ length: 10 }, () => ({ visual_direction: "A scene" })), "A topic", "/tmp"),
      /blocks paid Agnes models/
    );
  } finally {
    if (oldKey === undefined) delete process.env.AGNES_API_KEY;
    else process.env.AGNES_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.AGNES_VIDEO_MODEL;
    else process.env.AGNES_VIDEO_MODEL = oldModel;
  }
});
