const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { enqueueGpuJob, claimNextGpuJob, receiveGpuScene } = require("./gpu-worker-bridge");

test("outbound GPU worker claims a job and uploads ten MP4 scenes", async () => {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-bridge-test-"));
  try {
    const prompts = Array.from({ length: 10 }, (_, i) => "A cinematic 3D scene showing physical action number " + i);
    const completed = enqueueGpuJob({ prompts, seed: 1234, workDir });
    const claimed = claimNextGpuJob();
    assert.ok(claimed);
    assert.equal(claimed.prompts.length, 10);
    assert.equal(claimed.seed, 1234);
    for (let index = 0; index < 10; index++) {
      const mp4 = Buffer.alloc(24000);
      mp4.write("ftyp", 4, "ascii");
      const result = await receiveGpuScene(claimed.job_id, index, mp4);
      assert.equal(result.received, index + 1);
      assert.equal(result.completed, index === 9);
    }
    const files = await completed;
    assert.equal(files.length, 10);
    for (const file of files) assert.equal((await fs.promises.stat(file)).size, 24000);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
});

test("outbound GPU worker rejects non-MP4 scene uploads", async () => {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-bridge-test-"));
  const completed = enqueueGpuJob({
    prompts: Array.from({ length: 10 }, () => "A cinematic 3D scene showing a clear physical action"),
    seed: 1,
    workDir
  });
  const claimed = claimNextGpuJob();
  await assert.rejects(receiveGpuScene(claimed.job_id, 0, Buffer.from("not a video")), /invalid or incomplete MP4/);
  const { failGpuJob } = require("./gpu-worker-bridge");
  failGpuJob(claimed.job_id, "Test cleanup");
  await assert.rejects(completed, /Test cleanup/);
  await fs.promises.rm(workDir, { recursive: true, force: true });
});
