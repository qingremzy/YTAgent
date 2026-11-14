const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { enqueueGpuJob, claimNextGpuJob, noteGpuWorkerPoll, getGpuWorkerStatus, updateGpuJobProgress, receiveGpuScene, receiveGpuAudio, failGpuJob } = require("./gpu-worker-bridge");

test("outbound GPU worker returns ten MP4 scenes and ten Kokoro narration tracks", async () => {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-bridge-test-"));
  try {
    const prompts = Array.from({ length: 10 }, (_, i) => "A cinematic 3D scene showing physical action number " + i);
    const narrations = Array.from({ length: 10 }, (_, i) => "This is the documentary narration for scene number " + i);
    const progressUpdates = [];
    const completed = enqueueGpuJob({ prompts, narrations, seed: 1234, workDir, onProgress: (progress, message) => progressUpdates.push({ progress, message }) });
    const claimed = claimNextGpuJob();
    assert.ok(claimed);
    assert.equal(claimed.prompts.length, 10);
    assert.equal(claimed.narrations.length, 10);
    assert.equal(claimed.seed, 1234);
    assert.equal(updateGpuJobProgress(claimed.job_id, 44, "Rendering scene 6"), true);
    assert.equal(updateGpuJobProgress(claimed.job_id, 20, "Older status"), true);
    assert.deepEqual(progressUpdates, [{ progress: 44, message: "Rendering scene 6" }, { progress: 44, message: "Older status" }]);
    for (let index = 0; index < 10; index++) {
      const mp4 = Buffer.alloc(24000);
      mp4.write("ftyp", 4, "ascii");
      const result = await receiveGpuScene(claimed.job_id, index, mp4);
      assert.equal(result.received, index + 1);
      assert.equal(result.completed, false);
    }
    for (let index = 0; index < 10; index++) {
      const wav = Buffer.alloc(4096);
      wav.write("RIFF", 0, "ascii");
      wav.write("WAVE", 8, "ascii");
      const result = await receiveGpuAudio(claimed.job_id, index, wav);
      assert.equal(result.received, index + 1);
      assert.equal(result.completed, index === 9);
    }
    const result = await completed;
    assert.equal(result.clips.length, 10);
    assert.equal(result.narrations.length, 10);
    for (const file of [...result.clips, ...result.narrations]) assert.ok((await fs.promises.stat(file)).size > 1000);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
});

test("outbound GPU worker rejects non-MP4 scene uploads", async () => {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-bridge-test-"));
  const completed = enqueueGpuJob({
    prompts: Array.from({ length: 10 }, () => "A cinematic 3D scene showing a clear physical action"),
    narrations: Array.from({ length: 10 }, () => "A short documentary narration line for this scene"),
    seed: 1,
    workDir
  });
  const claimed = claimNextGpuJob();
  await assert.rejects(receiveGpuScene(claimed.job_id, 0, Buffer.from("not a video")), /invalid or incomplete MP4/);
  failGpuJob(claimed.job_id, "Test cleanup");
  await assert.rejects(completed, /Test cleanup/);
  await fs.promises.rm(workDir, { recursive: true, force: true });
});

test("detects a worker heartbeat and fails jobs that are never claimed", async () => {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-bridge-offline-"));
  try {
    noteGpuWorkerPoll();
    assert.equal(getGpuWorkerStatus().online, true);
    const queued = enqueueGpuJob({
      prompts: Array.from({ length: 10 }, () => "A detailed 3D scene with a distinct physical action"),
      narrations: Array.from({ length: 10 }, () => "A documentary narration line with enough words"),
      seed: 2,
      workDir,
      claimTimeoutMs: 15
    });
    await assert.rejects(queued, /did not connect within 45 minutes/);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
});
