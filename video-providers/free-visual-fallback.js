const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");

function safe(value, max = 110) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function xml(value) {
  return safe(value, 120).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function buildFallbackArtwork(scene, index, total) {
  const title = xml(scene && (scene.title || scene.caption) || "A closer look");
  const detail = xml(scene && (scene.visual_direction || scene.caption) || "Explore the science");
  const hue = (190 + index * 29) % 360;
  const nodes = Array.from({ length: 9 }, (_, i) => {
    const angle = (Math.PI * 2 * i) / 9;
    const x = 360 + Math.cos(angle) * (145 + (i % 3) * 24);
    const y = 620 + Math.sin(angle) * (145 + (i % 3) * 24);
    return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (7 + i % 4 * 3) + '" fill="hsl(' + ((hue + i * 17) % 360) + ',90%,70%)" opacity=".9"/>' +
      '<path d="M360 620 L' + x.toFixed(1) + ' ' + y.toFixed(1) + '" stroke="hsl(' + hue + ',80%,72%)" stroke-width="2" opacity=".35"/>';
  }).join("");
  return '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">' +
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#071426"/><stop offset=".52" stop-color="#102b48"/><stop offset="1" stop-color="#050b19"/></linearGradient>' +
    '<radialGradient id="core"><stop stop-color="hsl(' + hue + ',95%,78%)" stop-opacity=".95"/><stop offset=".35" stop-color="hsl(' + hue + ',90%,55%)" stop-opacity=".55"/><stop offset="1" stop-color="hsl(' + hue + ',90%,40%)" stop-opacity="0"/></radialGradient>' +
    '<filter id="glow"><feGaussianBlur stdDeviation="22"/></filter></defs>' +
    '<rect width="720" height="1280" fill="url(#bg)"/>' +
    '<circle cx="360" cy="620" r="270" fill="url(#core)" filter="url(#glow)" opacity=".8"/>' +
    '<g fill="none" stroke="hsl(' + hue + ',85%,75%)" opacity=".32"><ellipse cx="360" cy="620" rx="235" ry="95" transform="rotate(-28 360 620)" stroke-width="3"/><ellipse cx="360" cy="620" rx="235" ry="95" transform="rotate(52 360 620)" stroke-width="3"/><circle cx="360" cy="620" r="190" stroke-dasharray="5 14"/></g>' +
    '<g>' + nodes + '</g>' +
    '<circle cx="360" cy="620" r="92" fill="url(#core)"/><circle cx="360" cy="620" r="52" fill="hsl(' + hue + ',95%,78%)" opacity=".8"/>' +
    '<g fill="#fff" opacity=".08">' + Array.from({length:36},(_,i)=>'<circle cx="'+((i*137)%720)+'" cy="'+((i*211)%1280)+'" r="'+(2+i%4)+'"/>').join("") + '</g>' +
    '<rect x="40" y="64" width="640" height="180" rx="28" fill="#020817" opacity=".78"/>' +
    '<text x="66" y="112" fill="#67e8f9" font-family="Arial" font-size="18" font-weight="700" letter-spacing="3">YT AGENT • VISUAL BACKUP • ' + (index + 1) + '/' + total + '</text>' +
    '<text x="66" y="172" fill="#fff" font-family="Arial" font-size="34" font-weight="800">' + title + '</text>' +
    '<rect x="40" y="970" width="640" height="250" rx="28" fill="#020817" opacity=".82"/>' +
    '<text x="66" y="1030" fill="#67e8f9" font-family="Arial" font-size="18" font-weight="700">THE SCIENCE, VISUALIZED</text>' +
    '<foreignObject x="66" y="1060" width="585" height="130"><div xmlns="http://www.w3.org/1999/xhtml" style="color:#fff;font:22px Arial,sans-serif;line-height:1.35">' + detail + '</div></foreignObject>' +
    '</svg>';
}
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("Fallback video render failed: " + stderr.slice(-1200))));
  });
}
async function generateFallbackSceneClips(scenes, workDir) {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable for the free visual fallback.");
  if (!Array.isArray(scenes) || scenes.length !== 10) throw new Error("The free visual fallback requires exactly ten scenes.");
  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const imagePath = path.join(workDir, "fallback-scene-" + String(i + 1).padStart(2, "0") + ".png");
    const videoPath = path.join(workDir, "fallback-scene-" + String(i + 1).padStart(2, "0") + ".mp4");
    await sharp(Buffer.from(buildFallbackArtwork(scenes[i], i, scenes.length))).png().toFile(imagePath);
    await run([
      "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", imagePath,
      "-vf", "zoompan=z='min(zoom+0.00045,1.07)':d=180:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=720x1280:fps=30,format=yuv420p",
      "-t", "6", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoPath
    ]);
    const stat = await fs.promises.stat(videoPath);
    if (stat.size < 15000) throw new Error("Fallback scene " + (i + 1) + " failed its file check.");
    clips.push(videoPath);
  }
  return clips;
}
module.exports = { buildFallbackArtwork, generateFallbackSceneClips };
