const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const jobs = new Map();
const pending = [];
const JOB_TIMEOUT_MS = 90 * 60 * 1000;

function enqueueGpuJob({ prompts, seed, workDir }) {
  if (!Array.isArray(prompts) || prompts.length !== 10) {
    return Promise.reject(new Error("The free GPU worker requires exactly ten scene prompts."));
  }
  const id = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    const job = { id, prompts, seed, workDir, state: "queued", clips: new Array(10), received: new Set(), resolve, reject };
    job.timer = setTimeout(() => {
      jobs.delete(id);
      reject(new Error("The free GPU worker did not finish within 90 minutes. Its notebook may be offline or out of GPU quota."));
    }, JOB_TIMEOUT_MS);
    if (job.timer.unref) job.timer.unref();
    jobs.set(id, job);
    pending.push(id);
  });
}

function claimNextGpuJob() {
  while (pending.length) {
    const id = pending.shift();
    const job = jobs.get(id);
    if (!job || job.state !== "queued") continue;
    job.state = "active";
    return { job_id: id, prompts: job.prompts, seed: job.seed };
  }
  return null;
}

async function receiveGpuScene(id, index, bytes) {
  const job = jobs.get(id);
  if (!job || job.state !== "active") throw new Error("This GPU job is no longer active.");
  if (!Number.isInteger(index) || index < 0 || index >= 10) throw new Error("Scene index must be between 0 and 9.");
  if (!Buffer.isBuffer(bytes) || bytes.length < 20000 || bytes.subarray(4, 8).toString() !== "ftyp") {
    throw new Error("The GPU worker uploaded an invalid or incomplete MP4 scene.");
  }
  if (job.received.has(index)) throw new Error("This scene was already received.");
  const filename = path.join(job.workDir, "wan-scene-" + String(index + 1).padStart(2, "0") + ".mp4");
  await fs.promises.writeFile(filename, bytes);
  job.clips[index] = filename;
  job.received.add(index);
  if (job.received.size === 10) {
    job.state = "completed";
    clearTimeout(job.timer);
    jobs.delete(id);
    job.resolve(job.clips);
    return { received: 10, completed: true };
  }
  return { received: job.received.size, completed: false };
}

function failGpuJob(id, message) {
  const job = jobs.get(id);
  if (!job) return false;
  job.state = "failed";
  clearTimeout(job.timer);
  jobs.delete(id);
  const safeMessage = String(message || "The free GPU worker failed.").replace(/[<>]/g, "").slice(0, 500);
  job.reject(new Error(safeMessage));
  return true;
}

module.exports = { enqueueGpuJob, claimNextGpuJob, receiveGpuScene, failGpuJob };
