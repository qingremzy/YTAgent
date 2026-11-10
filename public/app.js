const statusText = document.getElementById("status");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");
const form = document.getElementById("uploadForm");
const result = document.getElementById("result");
const submit = document.getElementById("submit");
const analyzeButton = document.getElementById("analyze");
const analysisStatus = document.getElementById("analysisStatus");
const videoInput = document.getElementById("video");
const downloadSrt = document.getElementById("downloadSrt");
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
let subtitlesSrt = "";

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
  subtitlesSrt = "";
  downloadSrt.classList.add("hidden");
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
    document.getElementById("socialCaption").value = a.social_caption || "";
    subtitlesSrt = a.subtitles_srt || "";
    downloadSrt.classList.toggle("hidden", !subtitlesSrt.trim());
    document.getElementById("subtitleStatus").textContent = subtitlesSrt.trim()
      ? "Subtitles generated. Download the SRT file to review or add to your video."
      : "No clear spoken dialogue was detected, so no subtitle file was generated.";
    analysisStatus.textContent = "Done. Review the title, description, tags and caption before publishing. Detected language: " + (a.language || "unknown") + ".";
  } catch (error) { analysisStatus.textContent = error.message; }
  finally { analyzeButton.disabled = false; analyzeButton.textContent = "✦ Analyse video & generate everything"; }
});
downloadSrt.addEventListener("click", () => {
  if (!subtitlesSrt) return;
  const blob = new Blob([subtitlesSrt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = "ytagent-subtitles.srt"; link.click();
  URL.revokeObjectURL(url);
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
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed.");
    result.innerHTML = 'Published successfully! <a target="_blank" rel="noopener" href="' + data.url + '">Open your YouTube video</a>';
    form.reset();
    subtitlesSrt = "";
    downloadSrt.classList.add("hidden");
    document.getElementById("subtitleStatus").textContent = "Generated from intelligible speech when available.";
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