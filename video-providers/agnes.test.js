const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPairPrompt,
  getVideoId,
  getTaskStatus,
  getVideoUrl
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
