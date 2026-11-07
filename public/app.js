const statusText = document.getElementById("status");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");
const form = document.getElementById("uploadForm");
const result = document.getElementById("result");
const submit = document.getElementById("submit");

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    statusText.textContent = data.connected ? "Connected: " + data.channel : (data.error || "Not connected yet.");
    connectButton.classList.toggle("hidden", !!data.connected);
    disconnectButton.classList.toggle("hidden", !data.connected);
  } catch { statusText.textContent = "Could not check connection."; }
}
document.getElementById("video").addEventListener("change", event => {
  document.getElementById("fileLabel").textContent = event.target.files[0]?.name || "Choose video from your device";
});
disconnectButton.addEventListener("click", async () => {
  await fetch("/auth/logout", { method: "POST" });
  refreshStatus();
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!form.video.files.length) return;
  submit.disabled = true;
  submit.textContent = "Uploading… keep this page open";
  result.classList.remove("hidden");
  result.textContent = "Uploading your video. Larger files may take a while. Please keep this page open.";
  try {
    const response = await fetch("/api/upload", { method: "POST", body: new FormData(form) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Upload failed.");
    result.innerHTML = 'Upload complete! <a target="_blank" rel="noopener" href="' + data.url + '">Open your YouTube video</a>';
    form.reset();
    document.getElementById("fileLabel").textContent = "Choose video from your device";
  } catch (error) { result.textContent = error.message; }
  finally { submit.disabled = false; submit.textContent = "Upload to YouTube"; }
});
document.getElementById("runCommand").addEventListener("click", () => {
  const command = document.getElementById("command").value.trim().toLowerCase();
  const reply = document.getElementById("commandReply");
  if (!command) { reply.textContent = "Type a command first."; return; }
  if (command.includes("post") || command.includes("upload") || command.includes("video")) {
    document.getElementById("video").click();
    reply.textContent = "Upload workflow ready. Choose your video, fill in the title, then tap Upload to YouTube.";
  } else reply.textContent = 'I can help with video uploads. Try: "post my new video".';
});
refreshStatus();