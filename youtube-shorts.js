const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");

function inspectShortsVideo(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-i", filePath, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const videoMatch = stderr.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/);
      if (!durationMatch || !videoMatch) return reject(new Error("YTAgent could not verify this video's duration and dimensions."));
      const durationSeconds = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
      const width = Number(videoMatch[1]);
      const height = Number(videoMatch[2]);
      if (width <= 0 || height <= 0 || height <= width) {
        return reject(new Error("Shorts-only publishing: video must be vertical (height greater than width)."));
      }
      if (durationSeconds <= 0 || durationSeconds > 180) {
        return reject(new Error("Shorts-only publishing: video must be longer than 0 seconds and no longer than 180 seconds."));
      }
      resolve({ durationSeconds, width, height });
    });
  });
}

module.exports = { inspectShortsVideo };
