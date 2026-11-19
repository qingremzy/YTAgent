const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const jobs = new Map();
const pending = [];
const JOB_TIMEOUT_MS = 90 * 60 * 1000;
// Free Kaggle GPU capacity can queue headless notebook runs for a while.
// Keep the single submitted run alive instead of failing and inviting duplicates.
const CLAIM_TIMEOUT_MS = 45 * 60 * 1000;
const QUEUE_HEARTBEAT_MS = 15000;
const WORKER_HEARTBEAT_TIMEOUT_MS = 45 * 60 * 1000;
const WORKER_HEARTBEAT_CHECK_MS = 15 * 1000;
let lastWorkerPollAt = 0;

function enqueueGpuJob({ prompts, narrations, seed, workDir, onProgress, onQueued, claimTimeoutMs = CLAIM_TIMEOUT_MS, queueHeartbeatMs = QUEUE_HEARTBEAT_MS }) {
  if (!Array.isArray(prompts) || prompts.length < 3 || prompts.length > 60 || !Array.isArray(narrations) || narrations.length !== prompts.length) {
    return Promise.reject(new Error("The free GPU worker requires 3–60 matched ten-second scene prompts and narration lines."));
  }
  const id = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    const sceneCount = prompts.length;
    const job = { id, prompts, narrations, sceneCount, seed, workDir, onProgress, progress: 0, state: "queued", clips: new Array(sceneCount), audios: new Array(sceneCount), received: new Set(), audioReceived: new Set(), lastHeartbeatAt: Date.now(), heartbeatTimer: null, queueHeartbeatTimer: null, resolve, reject };
    job.timer = setTimeout(() => {
      if (job.state === "queued") {
        if (job.queueHeartbeatTimer) clearInterval(job.queueHeartbeatTimer);
        jobs.delete(id);
        reject(new Error("The Kaggle GPU notebook did not connect within 45 minutes. Kaggle may have kept the notebook queued because free GPU capacity was unavailable. Check the latest Kaggle kernel status before starting another run."));
      } else {
        jobs.delete(id);
        reject(new Error("The free GPU worker did not finish within 90 minutes. Its notebook may have disconnected or run out of GPU quota."));
      }
    }, claimTimeoutMs);
    if (job.timer.unref) job.timer.unref();
    job.queueHeartbeatTimer = setInterval(() => {
      if (job.state !== "queued") return;
      const elapsed = Math.max(1, Math.round((Date.now() - job.lastHeartbeatAt) / 1000));
      const message = "Kaggle accepted the free GPU notebook. Waiting for its startup heartbeat (" + elapsed + "s). No scene has been rendered by the GPU worker yet.";
      console.log("YTAgent " + message);
      if (typeof job.onProgress === "function") {
        try {
          const pendingProgress = job.onProgress(19, message);
          if (pendingProgress && typeof pendingProgress.catch === "function") pendingProgress.catch(() => {});
        } catch (_) {}
      }
    }, Math.max(5, Number(queueHeartbeatMs) || QUEUE_HEARTBEAT_MS));
    if (job.queueHeartbeatTimer.unref) job.queueHeartbeatTimer.unref();
    jobs.set(id, job);
    pending.push(id);
    if (typeof onQueued === "function") {
      Promise.resolve().then(() => onQueued({ jobId: id })).catch(error => {
        failGpuJob(id, "Could not start the Kaggle GPU worker: " + (error.message || error));
      });
    }
  });
}

function updateGpuJobProgress(id, progress, message) {
  const job = jobs.get(id);
  if (!job || job.state !== "active") return false;
  const value = Math.max(0, Math.min(99, Math.round(Number(progress) || 0)));
  job.progress = Math.max(job.progress, value);
  job.lastHeartbeatAt = Date.now();
  const detail = String(message || "").replace(/[<>]/g, "").slice(0, 180);
  if (typeof job.onProgress === "function") {
    try {
      const pending = job.onProgress(job.progress, detail);
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch (_) {}
  }
  return true;
}

function noteGpuWorkerPoll() {
  lastWorkerPollAt = Date.now();
}

function getGpuWorkerStatus() {
  const ageMs = lastWorkerPollAt ? Date.now() - lastWorkerPollAt : null;
  return { online: ageMs !== null && ageMs < 45000, lastSeenSecondsAgo: ageMs === null ? null : Math.floor(ageMs / 1000) };
}

function claimNextGpuJob() {
  while (pending.length) {
    const id = pending.shift();
    const job = jobs.get(id);
    if (!job || job.state !== "queued") continue;
    clearTimeout(job.timer);
    if (job.queueHeartbeatTimer) clearInterval(job.queueHeartbeatTimer);
    job.state = "active";
    job.lastHeartbeatAt = Date.now();
    job.timer = setTimeout(() => {
      if (job.heartbeatTimer) clearInterval(job.heartbeatTimer);
      jobs.delete(id);
      job.reject(new Error("The free GPU worker did not finish within 90 minutes. Its notebook may have disconnected or run out of GPU quota."));
    }, JOB_TIMEOUT_MS);
    if (job.timer.unref) job.timer.unref();
    job.heartbeatTimer = setInterval(() => {
      if (Date.now() - job.lastHeartbeatAt <= WORKER_HEARTBEAT_TIMEOUT_MS) return;
      clearInterval(job.heartbeatTimer);
      clearTimeout(job.timer);
      jobs.delete(id);
      job.reject(new Error("The Kaggle GPU worker stopped reporting progress for 45 minutes. The batch run may have stopped, disconnected, or run out of resources. Restart the worker and try again."));
    }, WORKER_HEARTBEAT_CHECK_MS);
    if (job.heartbeatTimer.unref) job.heartbeatTimer.unref();
    return { job_id: id, prompts: job.prompts, narrations: job.narrations, seed: job.seed };
  }
  return null;
}

async function receiveGpuScene(id, index, bytes) {
  const job = jobs.get(id);
  if (!job || job.state !== "active") throw new Error("This GPU job is no longer active.");
  if (!Number.isInteger(index) || index < 0 || index >= job.sceneCount) throw new Error("Scene index is outside this GPU job.");
  if (!Buffer.isBuffer(bytes) || bytes.length < 20000 || bytes.subarray(4, 8).toString() !== "ftyp") {
    throw new Error("The GPU worker uploaded an invalid or incomplete MP4 scene.");
  }
  const filename = path.join(job.workDir, "wan-scene-" + String(index + 1).padStart(2, "0") + ".mp4");
  if (job.received.has(index)) {
    const existing = await fs.promises.readFile(filename);
    if (!existing.equals(bytes)) throw new Error("A different MP4 was already received for this scene.");
    job.lastHeartbeatAt = Date.now();
    return { received: job.received.size, completed: false, duplicate: true };
  }
  job.lastHeartbeatAt = Date.now();
  await fs.promises.writeFile(filename, bytes);
  job.clips[index] = filename;
  job.received.add(index);
  if (job.received.size === job.sceneCount && job.audioReceived.size === job.sceneCount) {
    job.state = "completed";
    clearTimeout(job.timer);
    if (job.heartbeatTimer) clearInterval(job.heartbeatTimer);
    jobs.delete(id);
    job.resolve({ clips: job.clips, narrations: job.audios });
    return { received: job.sceneCount, completed: true };
  }
  return { received: job.received.size, completed: false };
}

async function receiveGpuAudio(id, index, bytes) {
  const job = jobs.get(id);
  if (!job || job.state !== "active") throw new Error("This GPU job is no longer active.");
  if (!Number.isInteger(index) || index < 0 || index >= job.sceneCount) throw new Error("Narration index is outside this GPU job.");
  if (!Buffer.isBuffer(bytes) || bytes.length < 1000 || bytes.subarray(0, 4).toString() !== "RIFF" || bytes.subarray(8, 12).toString() !== "WAVE") {
    throw new Error("The GPU worker uploaded an invalid WAV narration file.");
  }
  const filename = path.join(job.workDir, "narration-" + String(index + 1).padStart(2, "0") + ".wav");
  if (job.audioReceived.has(index)) {
    const existing = await fs.promises.readFile(filename);
    if (!existing.equals(bytes)) throw new Error("A different WAV was already received for this narration.");
    job.lastHeartbeatAt = Date.now();
    return { received: job.audioReceived.size, completed: false, duplicate: true };
  }
  job.lastHeartbeatAt = Date.now();
  await fs.promises.writeFile(filename, bytes);
  job.audios[index] = filename;
  job.audioReceived.add(index);
  if (job.received.size === 10 && job.audioReceived.size === 10) {
    job.state = "completed";
    clearTimeout(job.timer);
    if (job.heartbeatTimer) clearInterval(job.heartbeatTimer);
    jobs.delete(id);
    job.resolve({ clips: job.clips, narrations: job.audios });
    return { received: 10, completed: true };
  }
  return { received: job.audioReceived.size, completed: false };
}

function failGpuJob(id, message) {
  const job = jobs.get(id);
  if (!job) return false;
  job.state = "failed";
  clearTimeout(job.timer);
  if (job.queueHeartbeatTimer) clearInterval(job.queueHeartbeatTimer);
  if (job.heartbeatTimer) clearInterval(job.heartbeatTimer);
  jobs.delete(id);
  const safeMessage = String(message || "The free GPU worker failed.").replace(/[<>]/g, "").slice(0, 500);
  job.reject(new Error(safeMessage));
  return true;
}

module.exports = { enqueueGpuJob, claimNextGpuJob, noteGpuWorkerPoll, getGpuWorkerStatus, updateGpuJobProgress, receiveGpuScene, receiveGpuAudio, failGpuJob };
