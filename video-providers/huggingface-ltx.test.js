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


test("LTX refuses to run without a configured Hugging Face token", async () => {
  const previous = process.env.HF_TOKEN;
  delete process.env.HF_TOKEN;
  try {
    const { getZeroGpuQuota } = require("./huggingface-ltx");
    const quota = await getZeroGpuQuota();
    assert.equal(quota.available, false);
    assert.match(quota.reason, /HF_TOKEN is not configured/);
  } finally {
    if (previous === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = previous;
  }
});

test("LTX quota gate allows only enough verified free quota for its capped fallback", async () => {
  const previousToken = process.env.HF_TOKEN;
  const previousFetch = global.fetch;
  process.env.HF_TOKEN = "hf-test-token";
  global.fetch = async url => ({
    ok: true,
    json: async () => ({ base: 300, current: 300, resetsAt: "2026-11-15T00:00:00Z" })
  });
  try {
    const { getZeroGpuQuota, LTX_MIN_QUOTA_SECONDS_PER_FILM } = require("./huggingface-ltx");
    const quota = await getZeroGpuQuota();
    assert.equal(quota.available, true);
    assert.equal(quota.remaining, 300);
    assert.equal(LTX_MIN_QUOTA_SECONDS_PER_FILM, 240);
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = previousToken;
  }
});

test("LTX quota gate skips generation when less than the required GPU time remains", async () => {
  const previousToken = process.env.HF_TOKEN;
  const previousFetch = global.fetch;
  process.env.HF_TOKEN = "hf-test-token";
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ base: 300, current: 180 })
  });
  try {
    const { getZeroGpuQuota } = require("./huggingface-ltx");
    const quota = await getZeroGpuQuota();
    assert.equal(quota.available, false);
    assert.equal(quota.remaining, 180);
    assert.match(quota.reason, /needs at least 240 seconds/);
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = previousToken;
  }
});
