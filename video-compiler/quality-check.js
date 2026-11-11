const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

function parseMediaInfo(stderr) {
  const text = String(stderr || "");
  const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : null;
  return {
    duration_seconds: duration,
    has_video: /Stream #\d+:\d+.*Video:/i.test(text),
    has_audio: /Stream #\d+:\d+.*Audio:/i.test(text)
  };
}

async function verifyRenderedVideo(filePath, options = {}) {
  const executable = options.ffmpegPath || ffmpegPath;
  if (!executable) throw new Error("FFmpeg is unavailable for the output quality check.");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, ["-hide_banner", "-v", "info", "-threads", "1", "-i", filePath, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stderr }));
  });
  if (result.code !== 0) throw new Error("Rendered MP4 failed a full FFmpeg decode check: " + result.stderr.slice(-1200));
  const info = parseMediaInfo(result.stderr);
  if (!info.has_video) throw new Error("Rendered MP4 has no readable video stream.");
  if (!info.has_audio) throw new Error("Rendered MP4 has no readable narration/audio stream.");
  if (info.duration_seconds === null || info.duration_seconds < 58 || info.duration_seconds > 62) {
    throw new Error("Rendered MP4 duration check failed. Expected approximately 60 seconds, detected " + String(info.duration_seconds) + " seconds.");
  }
  return { passed: true, duration_seconds: info.duration_seconds, has_video: true, has_audio: true, full_decode: true };
}
module.exports = { parseMediaInfo, verifyRenderedVideo };
