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
document.getElementById("runCommand").addEventListener("click", async () => {
  const command = document.getElementById("command").value.trim().toLowerCase();
  const reply = document.getElementById("commandReply");
  const button = document.getElementById("runCommand");
  if (!command) { reply.textContent = "Type a command first."; return; }
  if (/self[- ]?test|diagnos|system check|check (the )?system|health check/.test(command)) {
    button.disabled = true;
    button.textContent = "Checking…";
    reply.textContent = "Running read-only system checks. No video will be generated and nothing will be published.";
    try {
      const response = await fetch("/api/diagnostics", { cache: "no-store" });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || "System diagnostics failed.");
      const lines = (data.checks || []).map(item => {
        const mark = item.status === "passed" || item.status === "configured" ? "✓" : item.status === "failed" ? "✕" : "!";
        return mark + " " + item.name + ": " + item.detail;
      });
      reply.textContent = data.summary + "\n" + lines.join("\n") + "\nChecked: " + data.checkedAt;
    } catch (error) {
      reply.textContent = "Diagnostic request failed: " + error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Run";
    }
    return;
  }
  if (command.includes("post") || command.includes("upload") || command.includes("video") || command.includes("publish")) {
    videoInput.click();
    reply.textContent = "Choose your video, analyse it, review the generated details, then publish.";
  } else reply.textContent = "Try: run a complete self-test, or analyse and publish my video.";
});

const generatorForm = document.getElementById("generatorForm");
const generateButton = document.getElementById("generateVideo");
const generatorStatus = document.getElementById("generatorStatus");
const generatedDownload = document.getElementById("generatedDownload");
const generatedThumbnailPreview = document.getElementById("generatedThumbnailPreview");
const generatedPublish = document.getElementById("generatedPublish");
const generatedPublishStatus = document.getElementById("generatedPublishStatus");
let generatedFilename = "";
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
  const pack = document.getElementById("generatedProductionPack");
  if (pack) {
    document.getElementById("generatedContinuity").value = data.continuity_guide || "";
    document.getElementById("generatedNarrator").value = data.narrator_script || "";
    document.getElementById("generatedThumbnail").value = data.thumbnail_prompt || "";
    const sceneRoot = document.getElementById("generatedScenePrompts");
    sceneRoot.replaceChildren();
    (data.scene_prompts || []).forEach(scene => {
      const item = document.createElement("details");
      const heading = document.createElement("summary"); heading.textContent = "Clip " + scene.index + " · 10 seconds";
      const prompt = document.createElement("p"); prompt.textContent = scene.prompt;
      const narration = document.createElement("p"); narration.textContent = "Narration: " + scene.narration;
      item.append(heading, prompt, narration); sceneRoot.appendChild(item);
    });
    pack.classList.remove("hidden");
  }
  generatedFilename = String(data.downloadUrl || "").split("/").pop();
  if (generatedPublish) generatedPublish.classList.remove("hidden");
  if (data.studioProjectId && generatedEdit) {
    generatedEdit.href = "/studio?project=" + encodeURIComponent(data.studioProjectId);
    generatedEdit.textContent = "Open editable production studio ↗";
    const keepMs = data.storage?.projectStored ? 30 * 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
    try { localStorage.setItem(lastStudioProjectKey, JSON.stringify({ id: data.studioProjectId, expiresAt: Date.now() + keepMs })); } catch (_) {}
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
if (generatedPublish) generatedPublish.addEventListener("click", async () => {
  if (!generatedFilename) return;
  generatedPublish.disabled = true;
  generatedPublish.textContent = "Uploading to YouTube…";
  generatedPublishStatus.textContent = "Uploading the completed MP4 using your connected YouTube account.";
  try {
    const response = await fetch("/api/generated/" + encodeURIComponent(generatedFilename) + "/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.elements.title.value,
        description: form.elements.description.value,
        tags: form.elements.tags.value,
        keywords: form.elements.keywords.value,
        hashtags: form.elements.hashtags.value,
        privacy: form.elements.privacy.value
      })
    });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "YouTube publishing failed.");
    generatedPublishStatus.textContent = "Published successfully: " + data.url + (data.thumbnailSet ? " · custom thumbnail uploaded." : " · thumbnail upload warning: " + (data.thumbnailError || "not set"));
    generatedPublishStatus.innerHTML = "";
    const link = document.createElement("a");
    link.href = data.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open published YouTube video ↗";
    generatedPublishStatus.appendChild(link);
  } catch (error) {
    generatedPublishStatus.textContent = error.message;
  } finally {
    generatedPublish.disabled = false;
    generatedPublish.textContent = "Publish this finished film to YouTube";
  }
});

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
const durationSelect = document.getElementById("videoDuration");
const customDurationWrap = document.getElementById("customDurationWrap");
const customDurationInput = document.getElementById("customDuration");
const loadIdeasButton = document.getElementById("loadIdeas");
const ideaList = document.getElementById("ideaList");
if (durationSelect) durationSelect.addEventListener("change", () => {
  customDurationWrap.classList.toggle("hidden", durationSelect.value !== "custom");
});
if (loadIdeasButton) loadIdeasButton.addEventListener("click", async () => {
  loadIdeasButton.disabled = true;
  loadIdeasButton.textContent = "Loading ideas…";
  try {
    const response = await fetch("/api/ideas", { cache: "no-store" });
    const data = await readJsonResponse(response);
    if (!response.ok || !Array.isArray(data.ideas) || data.ideas.length !== 10) throw new Error(data.error || "The ten story ideas could not be loaded.");
    ideaList.replaceChildren();
    data.ideas.forEach((idea, index) => {
      const card = document.createElement("article");
      card.className = "idea-card";
      const number = document.createElement("small");
      number.textContent = "IDEA " + String(index + 1).padStart(2, "0");
      const title = document.createElement("strong");
      title.textContent = idea.title;
      const hook = document.createElement("p");
      hook.textContent = idea.hook;
      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "button secondary";
      choose.textContent = "Use this idea";
      choose.addEventListener("click", () => {
        document.getElementById("videoTopic").value = idea.title;
        generatorStatus.textContent = "Selected: " + idea.title + ". You can edit the premise before production.";
        ideaList.querySelectorAll(".idea-card").forEach(item => item.classList.remove("selected"));
        card.classList.add("selected");
      });
      card.append(number, title, hook, choose);
      ideaList.appendChild(card);
    });
    ideaList.classList.remove("hidden");
  } catch (error) {
    generatorStatus.textContent = error.message;
  } finally {
    loadIdeasButton.disabled = false;
    loadIdeasButton.textContent = "Show 10 ideas";
  }
});

const researchButton = document.getElementById("researchTopic");
const researchResults = document.getElementById("researchResults");
if (researchButton) researchButton.addEventListener("click", async () => {
  const topic = document.getElementById("videoTopic").value.trim();
  if (topic.length < 3) { generatorStatus.textContent = "Enter a topic first, then run niche research."; return; }
  researchButton.disabled = true;
  researchButton.textContent = "Researching YouTube…";
  researchResults.classList.remove("hidden");
  researchResults.textContent = "Collecting public video views, channel subscribers and average video lengths…";
  try {
    const response = await fetch("/api/research?topic=" + encodeURIComponent(topic), { cache: "no-store" });
    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(data.error || "YouTube research failed.");
    researchResults.replaceChildren();
    const summary = document.createElement("p");
    summary.textContent = "Research sample: " + data.sampleSize + " top videos · average views: " + Number(data.averageViews || 0).toLocaleString() + " · average duration: " + Math.floor((data.averageDurationSeconds || 0) / 60) + "m " + ((data.averageDurationSeconds || 0) % 60) + "s";
    researchResults.appendChild(summary);
    (data.videos || []).slice(0, 10).forEach(video => {
      const item = document.createElement("p");
      const link = document.createElement("a");
      link.href = video.url; link.target = "_blank"; link.rel = "noopener"; link.textContent = video.title;
      const stats = document.createElement("small");
      stats.textContent = " · " + Number(video.views || 0).toLocaleString() + " views · " + video.channelTitle;
      item.append(link, stats); researchResults.appendChild(item);
    });
    const channelHeading = document.createElement("strong");
    channelHeading.textContent = "Channels in the sample";
    researchResults.appendChild(channelHeading);
    (data.channels || []).slice(0, 10).forEach(channel => {
      const item = document.createElement("p");
      item.textContent = channel.title + " · " + Number(channel.subscribers || 0).toLocaleString() +
        " subscribers · " + Number(channel.totalViews || 0).toLocaleString() + " channel views · " +
        Number(channel.videoCount || 0).toLocaleString() + " uploads";
      researchResults.appendChild(item);
    });
    const note = document.createElement("small");
    note.textContent = data.note || "";
    researchResults.appendChild(note);
  } catch (error) {
    researchResults.textContent = error.message;
  } finally {
    researchButton.disabled = false;
    researchButton.textContent = "Research popular YouTube videos in this niche";
  }
});

generatorForm.addEventListener("submit", async event => {
  event.preventDefault();
  const topic = document.getElementById("videoTopic").value.trim();
  const durationSeconds = durationSelect.value === "custom" ? Number(customDurationInput.value) : Number(durationSelect.value);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 600 || durationSeconds % 10 !== 0) {
    generatorStatus.textContent = "Custom duration must be 30–600 seconds in 10-second increments.";
    return;
  }
  if (!topic) return;
  generateButton.disabled = true;
  setGenerationLoading(true);
  updateGenerationProgress(1, "AI director is planning the film.");
  generateButton.textContent = "Generating video…";
  generatorStatus.textContent = "Stage 3: building the continuity guide and " + (durationSeconds / 10) + " connected ten-second clip prompts. Then YTAgent generates visuals, records scene-synced narration, assembles the MP4 and prepares its upload metadata."
  generatedDownload.classList.add("hidden");
  if (generatedEdit) generatedEdit.classList.add("hidden");
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, durationSeconds })
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
    generateButton.textContent = "✦ Run 5-stage production";
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
      generateButton.textContent = "✦ Run 5-stage production";
    });
  }
} catch (_) {
  localStorage.removeItem(generationStorageKey);
}


