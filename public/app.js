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

async function waitForAnalysis(jobId) {
  for (;;) {
    const response = await fetch("/api/analyze/" + encodeURIComponent(jobId));
    const data = await response.json();
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
    let payload = await response.json();
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
remove SRT download handlerform.addEventListener("submit", async event => {
  event.preventDefault();
  if (!form.video.files.length) return;
  submit.disabled = true;
  submit.textContent = "Publishing… keep this page open";
  result.classList.remove("hidden");
  result.textContent = "Uploading your video to YouTube. Please keep this page open.";
  try {
    const response = await fetch("/api/upload", { method: "POST", body: new FormData(form) });
    const data = await response.json();
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
refreshStatus();