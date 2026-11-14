const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSseResult, buildPrompt } = require("./huggingface-ltx");

test("LTX completion SSE extracts the Gradio video URL", () => {
  const raw = [
    "event: status\ndata: {\"stage\":\"processing\"}",
    "event: complete\ndata: [{\"video\":{\"url\":\"https://cdn.example/video.mp4\",\"path\":\"/tmp/video.mp4\"}},123]"
  ].join("\n\n");
  assert.equal(parseSseResult(raw), "https://cdn.example/video.mp4");
});

test("LTX error SSE becomes a provider error", () => {
  assert.throws(
    () => parseSseResult("event: error\ndata: null"),
    /LTX/
  );
});

test("LTX completion without a video URL is rejected", () => {
  assert.throws(
    () => parseSseResult("event: complete\ndata: [{\"video\":{}},123]"),
    /downloadable video file/
  );
});

test("LTX prompt includes scene-specific physical action and topic", () => {
  const prompt = buildPrompt(
    { visual_direction: "A beekeeper watches worker bees perform a waggle dance inside a wooden hive." },
    "How honeybees communicate",
    2
  );
  assert.match(prompt, /How honeybees communicate/);
  assert.match(prompt, /waggle dance/);
  assert.match(prompt, /Shot 3 of 10/);
});

test("LTX empty ZeroGPU error explains shared queue unavailability", () => {
  assert.throws(
    () => parseSseResult("event: error\ndata: null"),
    /shared Space may be out of GPU capacity/
  );
});
