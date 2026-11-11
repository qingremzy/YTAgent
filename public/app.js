const statusText = document.getElementById("status");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");
const form = document.getElementById("uploadForm");
const result = document.getElementById("result");
const submit = document.getElementById("submit");
const analyzeButton = document.getElementById("analyze");
const analysisStatus = document.getElementById("analysisStatus");
const videoInput = document.getElementById("video");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJsonResponse(response) {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : {}; }
  catch {
    const preview = raw.trim().slice(0, 180);
    throw new Error("Server returned an invalid response (HTTP " + response.status + "). " + (preview || "Please try again."));
  }
}
async function waitForAnalysis(jobId) {
  for (;;) {
    const response = await fetch("/api/analyze/" + encodeURIComponent(jobId));
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Could not check analysis progress.");
    if (data.state === "completed") return data.analysis;
    if (data.state === "failed") throw new Error(data.error || "Video analysis failed.");
    analysisStatus.textContent = "Your video is in the parallel task queue (" + (data.state || "waiting") + ").";
    await wait(1500);
  }
}
async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    statusText.textContent = data.connected ? "Connected: " + data.channel : (data.error || "Not connected yet.");
    connectButton.classList.toggle("hidden", !!data.connected);
    disconnectButton.classList.toggle("hidden", !data.connected);
  } catch { statusText.textContent = "Could not check connection."; }
}
videoInput.addEventListener("change", event => {
  document.getElementById("fileLabel").textContent = event.target.files[0]?.name || "Choose video from your device";
  analysisStatus.textContent = "";
});
disconnectButton.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  refreshStatus();
});
analyzeButton.addEventListener("click", async () => {
  if (!videoInput.files.length) { analysisStatus.textContent = "Choose a video first."; return; }
  analyzeButton.disabled = true;
  analyzeButton.textContent = "Analysing video…";
  analysisStatus.textContent = "Submitting your video for AI analysis. You can generate details before connecting YouTube.";
  const data = new FormData();
  data.append("video", videoInput.files[0]);
  try {
    const response = await fetch("/api/analyze", { method: "POST", body: data });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload.error || "Video analysis failed.");
    const a = payload.queued ? await waitForAnalysis(payload.jobId) : payload.analysis;
    form.elements.title.value = a.title || "";
    form.elements.description.value = a.description || "";
    form.elements.tags.value = (a.tags || []).join(", ");
    form.elements.hashtags.value = (a.hashtags || []).join(" ");
    form.elements.keywords.value = (a.keywords || []).join(", ");
    document.getElementById("aiProviders").textContent = "AI reviewers used: " + (a.ai_providers || ["Google Gemini"]).join(" + ") + ".";
    analysisStatus.textContent = "Done. Review the title, description, tags, keywords and hashtags before publishing. Detected language: " + (a.language || "unknown") + ".";
  } catch (error) { analysisStatus.textContent = error.message; }
  finally { analyzeButton.disabled = false; analyzeButton.textContent = "✦ Analyse video & generate everything"; }
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!form.video.files.length) return;
  submit.disabled = true;
  submit.textContent = "Publishing… keep this page open";
  result.classList.remove("hidden");
  result.textContent = "Uploading your video to YouTube. Please keep this page open.";
  try {
    const response = await fetch("/api/upload", { method: "POST", body: new FormData(form) });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "Upload failed.");
    result.innerHTML = 'Published successfully! <a target="_blank" rel="noopener" href="' + data.url + '">Open your YouTube video</a>';
    form.reset();
    document.getElementById("fileLabel").textContent = "Choose video from your device";
    analysisStatus.textContent = "";
  } catch (error) { result.textContent = error.message; }
  finally { submit.disabled = false; submit.textContent = "Publish to YouTube"; }
});
document.getElementById("runCommand").addEventListener("click", () => {
  const command = document.getElementById("command").value.trim().toLowerCase();
  const reply = document.getElementById("commandReply");
  if (!command) { reply.textContent = "Type a command first."; return; }
  if (command.includes("post") || command.includes("upload") || command.includes("video") || command.includes("publish")) {
    videoInput.click();
    reply.textContent = "Choose your video, analyse it, review the generated details, then publish.";
  } else reply.textContent = 'Try: "analyse and publish my video".';
});

const generatorForm = document.getElementById("generatorForm");
const generateButton = document.getElementById("generateVideo");
const generatorStatus = document.getElementById("generatorStatus");
const generatedDownload = document.getElementById("generatedDownload");
const generatedEdit = document.getElementById("generatedEdit");
const lastStudioProjectKey = "ytagent-last-studio-project";
function restoreLastStudioProject() {
  if (!generatedEdit) return;
  try {
    const saved = JSON.parse(localStorage.getItem(lastStudioProjectKey) || "null");
    if (!saved || !/^[a-f0-9]{24}$/i.test(String(saved.id || "")) || Number(saved.expiresAt) <= Date.now()) {
      localStorage.removeItem(lastStudioProjectKey);
      return;
    }
    generatedEdit.href = "/studio?project=" + encodeURIComponent(saved.id);
    generatedEdit.textContent = "Reopen last editable studio ↗";
    generatedEdit.classList.remove("hidden");
  } catch (_) {
    localStorage.removeItem(lastStudioProjectKey);
  }
}
restoreLastStudioProject();
const generationOrb = document.getElementById("generationOrb");
const generationProgress = document.getElementById("generationProgress");
const generationProgressFill = document.getElementById("generationProgressFill");
const generationProgressLabel = document.getElementById("generationProgressLabel");
function setGenerationLoading(loading) {
  generationOrb.classList.toggle("hidden", !loading);
  if (!loading) generationProgress.classList.add("hidden");
}
function updateGenerationProgress(progress, message) {
  const value = Math.max(0, Math.min(99, Number(progress) || 0));
  generationProgress.classList.remove("hidden");
  generationProgressFill.style.width = value + "%";
  generationProgressLabel.textContent = Math.round(value) + "%";
  if (message) generatorStatus.textContent = message;
  window.dispatchEvent(new CustomEvent("ytagent:generation", { detail: { state: "active", progress: value, message: message || "Production is running." } }));
}
const generationStorageKey = "ytagent-generation-job";
function showGeneratedVideo(data, topic) {
  setGenerationLoading(false);
  generatedDownload.href = data.downloadUrl;
  generatedDownload.classList.remove("hidden");
  if (data.studioProjectId && generatedEdit) {
    generatedEdit.href = "/studio?project=" + encodeURIComponent(data.studioProjectId);
    generatedEdit.textContent = "Open editable production studio ↗";
    const keepMs = data.storage?.projectStored ? 30 * 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
    localStorage.setItem(lastStudioProjectKey, JSON.stringify({ id: data.studioProjectId, expiresAt: Date.now() + keepMs }));
    generatedEdit.classList.remove("hidden");
  } else if (generatedEdit) {
    generatedEdit.classList.add("hidden");
  }
  form.elements.title.value = data.title || topic;
  form.elements.description.value = data.description || "";
  form.elements.tags.value = (data.tags || []).join(", ");
  form.elements.hashtags.value = (data.hashtags || []).join(" ");
  form.elements.keywords.value = (data.keywords || []).join(", ");
  generatorStatus.textContent = "Your " + data.duration_seconds + "-second narrated MP4 is ready. Voice: " + (data.voice_provider || "AI voice") + ". Visuals: " + (data.visual_provider || "YTAgent video engine") + ". Open the editable studio to refine the timeline, export a final MP4, or publish to YouTube.";
  window.dispatchEvent(new CustomEvent("ytagent:generation", { detail: { state: "completed", progress: 100, message: "Your finished film is ready." } }));;
}
async function fetchGenerationStatus(jobId, deadline) {
  const url = "/api/generate/" + encodeURIComponent(jobId);
  let lastError;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (navigator.onLine === false) {
      generatorStatus.textContent = "Your film may still be generating. Waiting for your internet connection to return…";
      await Promise.race([new Promise(resolve => window.addEventListener("online", resolve, { once: true })), wait(15000)]);
      continue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { method: "GET", cache: "no-store", signal: controller.signal });
      clearTimeout(timeout);
      const data = await readJsonResponse(response);
      if (response.status === 404) {
        localStorage.removeItem(generationStorageKey);
        throw new Error(data.error || "This generation task is no longer available.");
      }
      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(data.error || "The server is temporarily busy.");
      } else {
        return { response, data };
      }
    } catch (error) {
      clearTimeout(timeout);
      if (error.message && !/fetch|network|abort|temporar|server returned an invalid response/i.test(error.message)) throw error;
      lastError = error;
    }
    const delay = Math.min(30000, 1500 * Math.pow(2, Math.min(attempt, 5)));
    attempt++;
    generatorStatus.textContent = "Connection interrupted. Your film may still be rendering. Reconnecting automatically in " + Math.ceil(delay / 1000) + " seconds…";
    await wait(delay);
  }
  throw lastError || new Error("The six-hour video task window has expired. Reload to check whether the video is ready.");
}
async function waitForGeneration(jobId) {
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const { response, data } = await fetchGenerationStatus(jobId, deadline);
    if (!response.ok) throw new Error(data.error || "Could not check video generation progress (HTTP " + response.status + ").");
    if (data.state === "completed") return data;
    if (data.state === "failed") {
      localStorage.removeItem(generationStorageKey);
      throw new Error(data.error || "Video generation failed.");
    }
    const state = data.state || "waiting";
    if (typeof data.progress === "number" && data.progress > 0) {
      updateGenerationProgress(data.progress, data.message || "YTAgent is creating your film.");
    } else {
      generatorStatus.textContent = state === "active"
        ? "YTAgent is creating your film. You can leave this page and return later."
        : "Your film is queued. Waiting for the video engine…";
    }
    await wait(8000);
  }
  throw new Error("This film is taking longer than expected. Your task ID is saved. Reload this page to resume checking.");
}
generatorForm.addEventListener("submit", async event => {
  event.preventDefault();
  const topic = document.getElementById("videoTopic").value.trim();
  if (!topic) return;
  generateButton.disabled = true;
  setGenerationLoading(true);
  updateGenerationProgress(1, "AI director is planning the film.");
  generateButton.textContent = "Generating video…";
  generatorStatus.textContent = "AI director is planning ten scenes. YTAgent is creating the visuals, generating narration, and assembling one complete MP4. This may take several minutes. You can leave and return later."
  generatedDownload.classList.add("hidden");
  if (generatedEdit) generatedEdit.classList.add("hidden");
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic })
    });
    const queued = await readJsonResponse(response);
    if (!response.ok) throw new Error(queued.error || "Video generation failed.");
    if (!queued.jobId) throw new Error("The server did not return a video task ID.");
    localStorage.setItem(generationStorageKey, JSON.stringify({ jobId: queued.jobId, topic }));
    const data = await waitForGeneration(queued.jobId);
    localStorage.removeItem(generationStorageKey);
    showGeneratedVideo(data, topic);
  } catch (error) {
    generatorStatus.textContent = error.message;
    window.dispatchEvent(new CustomEvent("ytagent:generation", { detail: { state: "failed", message: error.message } }));
  }
  finally {
    setGenerationLoading(false);
    generateButton.disabled = false;
    generateButton.textContent = "✦ Generate 60-second video";
  }
});
refreshStatus();

try {
  const savedJob = JSON.parse(localStorage.getItem(generationStorageKey) || "null");
  if (savedJob && savedJob.jobId) {
    generateButton.disabled = true;
    setGenerationLoading(true);
    generateButton.textContent = "Resuming video generation…";
    generatorStatus.textContent = "Resuming your previous video task. You can leave this page and return later.";
    waitForGeneration(savedJob.jobId).then(data => {
      localStorage.removeItem(generationStorageKey);
      showGeneratedVideo(data, savedJob.topic || "Your video");
    }).catch(error => {
      generatorStatus.textContent = error.message;
    }).finally(() => {
      setGenerationLoading(false);
      generateButton.disabled = false;
      generateButton.textContent = "✦ Generate 60-second video";
    });
  }
} catch (_) {
  localStorage.removeItem(generationStorageKey);
}


