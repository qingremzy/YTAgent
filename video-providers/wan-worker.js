const fs = require("fs");
const path = require("path");

const POLL_INTERVAL_MS = 10000;
const JOB_TIMEOUT_MS = 45 * 60 * 1000;

function clean(value, max = 500) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function buildWanScenePrompt(scene, topic, index) {
  const cameraMoves = [
    "slow cinematic push-in with shallow depth of field",
    "smooth lateral tracking shot following the action",
    "gentle orbit around the main subject",
    "slow crane movement revealing the environment",
    "steady close-up that racks focus to the background"
  ];
  return [
    "An original high-quality stylized 3D animated explainer film shot, portrait 9:16. This must look like a real animated scene from a 3D movie, not a diagram or abstract motion graphic.",
    "Overall subject: " + clean(topic, 180) + ".",
    "Shot " + (index + 1) + " of a continuous ten-shot explainer: " + clean(scene.visual_direction, 500) + ".",
    "Show the named physical subject clearly performing the described action in a recognizable location. Favor expressive 3D human characters, believable anatomy, tactile props, detailed sets, facial expression and readable cause-and-effect. Preserve the same character appearance and important object design between shots whenever described.",
    "Use solid geometry, physically plausible contact and weight, natural body mechanics, rich but realistic materials, cinematic key and rim lighting, detailed backgrounds and film-quality depth of field.",
    "Animate a clear action throughout the entire shot. The subject must move or interact with an object. Camera: " + cameraMoves[index % cameraMoves.length] + ".",
    "Avoid abstract swirls, atom diagrams, orbiting dots, glowing rings, floating particles, fractal patterns, generic science wallpaper, empty backgrounds, frozen poses and unrelated imagery. Do not show symbols as a substitute for the real subject.",
    "Keep one main subject large and centered for vertical mobile viewing. No text, subtitles, logos, watermarks, borders, slideshows or split screens.",
    "Stable anatomy, coherent object shapes, continuous natural movement. Original characters and visual identity only. Do not imitate an existing creator or copyrighted character."
  ].join(" ");
}

async function workerRequest(baseUrl, token, route, options = {}, timeoutMs = 60000) {
  let response;
  try {
    response = await fetch(baseUrl + route, {
      ...options,
      headers: { Authorization: "Bearer " + token, ...(options.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new Error("Wan GPU worker is unreachable: " + (error.message || "network error"));
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error("Wan GPU worker returned HTTP " + response.status + (detail ? ": " + detail : ""));
  }
  return response;
}

async function generateWanSceneClips(scenes, topic, workDir) {
  const configuredUrl = process.env.VIDEO_WORKER_URL;
  const token = process.env.YT_AGENT_WORKER_TOKEN;
  if (!configuredUrl || !token) {
    throw new Error("Wan GPU worker is not configured. Set VIDEO_WORKER_URL and YT_AGENT_WORKER_TOKEN while the free GPU notebook is running.");
  }
  if (!Array.isArray(scenes) || scenes.length !== 10) {
    throw new Error("Wan GPU worker requires exactly ten storyboard scenes.");
  }
  let baseUrl;
  try {
    baseUrl = new URL(configuredUrl).toString().replace(/\/$/, "");
    if (new URL(baseUrl).protocol !== "https:") throw new Error("HTTPS is required.");
  } catch (error) {
    throw new Error("VIDEO_WORKER_URL must be a valid HTTPS URL: " + error.message);
  }

  // Check the temporary Kaggle/Cloudflare endpoint before submitting a costly GPU job.
  // Cloudflare trycloudflare URLs change when the tunnel or notebook session restarts.
  try {
    const health = await fetch(baseUrl + "/health", { signal: AbortSignal.timeout(12000) });
    if (!health.ok) {
      throw new Error("health check returned HTTP " + health.status);
    }
    const healthData = await health.json().catch(() => ({}));
    if (healthData.ok !== true || healthData.service !== "ytagent-wan-worker") {
      throw new Error("the endpoint did not identify itself as the YTAgent GPU worker");
    }
  } catch (error) {
    throw new Error(
      "The free Kaggle GPU worker cannot be reached at VIDEO_WORKER_URL. " +
      "Its Cloudflare tunnel may have expired. Refresh the existing Kaggle notebook (run the code-update cell, restart the worker cell, then check the tunnel URL) and update VIDEO_WORKER_URL in Railway. " +
      "Details: " + clean(error.message || error, 220)
    );
  }

  const submitted = await workerRequest(baseUrl, token, "/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenes: scenes.map((scene, index) => ({ prompt: buildWanScenePrompt(scene, topic, index) })),
      seed: 20261110
    })
  });
  const start = await submitted.json().catch(() => ({}));
  const jobId = String(start.job_id || "");
  if (!/^[a-f0-9]{32}$/i.test(jobId)) {
    throw new Error("Wan GPU worker accepted the request but returned an invalid job ID.");
  }

  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let lastStatus = "";
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    const statusResponse = await workerRequest(baseUrl, token, "/jobs/" + jobId);
    const status = await statusResponse.json().catch(() => ({}));
    const state = String(status.status || "").toLowerCase();
    if (state !== lastStatus) {
      console.log("YTAgent Wan worker:", state || "waiting", status.progress || 0, "%", status.message || "");
      lastStatus = state;
    }
    if (state === "failed") {
      throw new Error("Wan GPU generation failed: " + clean(status.message || "Unknown worker error", 500));
    }
    if (state === "completed") {
      const clips = [];
      for (let index = 0; index < 10; index++) {
        const response = await workerRequest(baseUrl, token, "/jobs/" + jobId + "/scenes/" + index, {}, 120000);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 20000 || bytes.subarray(4, 8).toString() !== "ftyp") {
          throw new Error("Wan GPU worker returned an invalid or incomplete MP4 for scene " + (index + 1) + ".");
        }
        const destination = path.join(workDir, "wan-scene-" + String(index + 1).padStart(2, "0") + ".mp4");
        await fs.promises.writeFile(destination, bytes);
        clips.push(destination);
      }
      return clips;
    }
    if (["cancelled", "canceled", "error"].includes(state)) {
      throw new Error("Wan GPU worker stopped the generation job: " + clean(status.message || state, 400));
    }
  }
  throw new Error("Wan GPU generation timed out after 45 minutes. Keep the free Kaggle GPU session running and retry.");
}

module.exports = { generateWanSceneClips, buildWanScenePrompt };
