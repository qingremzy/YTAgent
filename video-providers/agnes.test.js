const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPairPrompt,
  buildCinematicShotDirection,
  generateSceneClips,
  getVideoId,
  getTaskStatus,
  getVideoUrl,
  isSuccessfulStatus,
  isFailedStatus,
  getGenerationErrorDetail,
  getRetryAfterMs,
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
  assert.match(prompt, /Camera and lens direction/);
  assert.match(prompt, /85mm cinema prime/);
  assert.match(buildPairPrompt(
    { visual_direction: "A cell moves" },
    { visual_direction: "It divides" },
    "Cell division",
    1
  ), /35mm anamorphic lens/);
});

test("cycles through distinct cinematic camera direction presets", () => {
  assert.match(buildCinematicShotDirection(0), /macro push-in/);
  assert.match(buildCinematicShotDirection(1), /lateral tracking/);
  assert.match(buildCinematicShotDirection(2), /orbital move/);
  assert.equal(buildCinematicShotDirection(5), buildCinematicShotDirection(0));
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

test("recognizes provider success and failure status aliases", () => {
  for (const status of ["completed", "succeeded", "success"]) {
    assert.equal(isSuccessfulStatus(status), true);
  }
  for (const status of ["failed", "error", "cancelled", "canceled", "rejected"]) {
    assert.equal(isFailedStatus(status), true);
  }
  assert.equal(isSuccessfulStatus("processing"), false);
  assert.equal(isFailedStatus("processing"), false);
});

test("extracts provider error details and accepts alternate output shapes", () => {
  assert.equal(getGenerationErrorDetail({ data: { error: { message: "render failed" } } }), "render failed");
  assert.equal(getVideoUrl({ data: { outputs: ["https://cdn.example/out.mp4"] } }), "https://cdn.example/out.mp4");
  assert.equal(getVideoUrl({ output: { url: "https://cdn.example/out2.mp4" } }), "https://cdn.example/out2.mp4");
});

test("parses Retry-After seconds and HTTP dates safely", () => {
  assert.equal(getRetryAfterMs(new Headers({ "retry-after": "5" })), 5000);
  assert.equal(getRetryAfterMs(new Headers()), 0);
  assert.equal(getRetryAfterMs(null), 0);
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
