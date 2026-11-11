const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateRewindSceneClips, getJobId, getVideoUrl } = require("./rewind");

test("reads Rewind job identifiers and completed video URLs", () => {
  assert.equal(getJobId({ id: "job_123456" }), "job_123456");
  assert.equal(getJobId({ job_id: "job_abcdef" }), "job_abcdef");
  assert.equal(getVideoUrl({ output: { urls: ["https://cdn.example/video.mp4"] } }), "https://cdn.example/video.mp4");
});

test("requires an API key and exactly ten storyboard scenes", async () => {
  const oldKey = process.env.REWIND_API_KEY;
  delete process.env.REWIND_API_KEY;
  try {
    await assert.rejects(generateRewindSceneClips([], "test", os.tmpdir()), /REWIND_API_KEY/);
    process.env.REWIND_API_KEY = "test-key";
    await assert.rejects(generateRewindSceneClips([], "test", os.tmpdir()), /exactly ten/);
  } finally {
    if (oldKey === undefined) delete process.env.REWIND_API_KEY;
    else process.env.REWIND_API_KEY = oldKey;
  }
});

test("generates, polls and downloads ten Rewind MP4 scenes", async () => {
  const oldKey = process.env.REWIND_API_KEY;
  const oldFetch = global.fetch;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-rewind-"));
  process.env.REWIND_API_KEY = "test-key";
  let jobCounter = 0;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/v1/videos/generate-async")) {
      jobCounter++;
      return new Response(JSON.stringify({ id: "job_" + String(jobCounter).padStart(6, "0"), status: "QUEUED" }), { status: 200 });
    }
    if (String(url).includes("/v1/jobs/")) {
      return new Response(JSON.stringify({ status: "COMPLETED", output: { urls: ["https://cdn.example/scene.mp4"] } }), { status: 200 });
    }
    const bytes = Buffer.alloc(24000);
    bytes.write("ftyp", 4, "ascii");
    return new Response(bytes, { status: 200 });
  };
  try {
    const scenes = Array.from({ length: 10 }, (_, i) => ({ visual_direction: "A character performs action " + i }));
    const clips = await generateRewindSceneClips(scenes, "test topic", dir);
    assert.equal(clips.length, 10);
    assert.equal(jobCounter, 10);
    for (const clip of clips) {
      const bytes = await fs.promises.readFile(clip);
      assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
    }
  } finally {
    global.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.REWIND_API_KEY;
    else process.env.REWIND_API_KEY = oldKey;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
