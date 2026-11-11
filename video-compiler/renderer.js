/**
 * Deterministic FFmpeg renderer for YTAgent's structured 60-second film plan.
 * Each shot requires a visual plate AND a narrator audio segment.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");
const WIDTH = 720, HEIGHT = 1280, FPS = 30, DURATION = 60;

function clean(value, max) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max || 200);
}
function xml(value) {
  return clean(value, 220).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function run(args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let spawnError = "";
    let child;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    try {
      child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      finish(new Error("FFmpeg could not start: " + (error.message || String(error))));
      return;
    }
    if (child.stderr) child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.once("error", error => {
      spawnError = error.message || String(error);
      finish(new Error("FFmpeg process could not start: " + spawnError));
    });
    child.once("close", (code, signal) => {
      if (code === 0) return finish();
      const reason = signal ? "terminated by signal " + signal : "exited with code " + String(code);
      const detail = stderr.trim() || spawnError || "FFmpeg produced no diagnostic output. The hosting service may have stopped the process, for example due to memory limits.";
      finish(new Error("FFmpeg render failed (" + reason + "): " + detail.slice(-5000)));
    });
  });
}
function wrap(value, maxChars, maxLines) {
  const words = clean(value, 220).split(/\s+/), lines = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line); line = word;
      if (lines.length >= maxLines) break;
    } else line = (line + " " + word).trim();
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}
async function makeOverlay(scene, index, total, output) {
  const title = wrap(scene.title || "The next discovery", 23, 2);
  const caption = wrap(scene.caption || scene.narration, 31, 3);
  const titleText = title.map((line, i) => '<tspan x="48" dy="' + (i ? 48 : 0) + '">' + xml(line) + "</tspan>").join("");
  const captionText = caption.map((line, i) => '<tspan x="48" dy="' + (i ? 37 : 0) + '">' + xml(line) + "</tspan>").join("");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">' +
    '<defs><linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#020817" stop-opacity=".9"/><stop offset="1" stop-color="#020817" stop-opacity="0"/></linearGradient>' +
    '<linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#020817" stop-opacity="0"/><stop offset=".3" stop-color="#020817" stop-opacity=".84"/><stop offset="1" stop-color="#020817" stop-opacity=".97"/></linearGradient></defs>' +
    '<rect width="720" height="300" fill="url(#top)"/><rect y="820" width="720" height="460" fill="url(#bottom)"/>' +
    '<text x="48" y="54" fill="#67e8f9" font-family="Arial" font-size="18" font-weight="700" letter-spacing="3">YT AGENT • ' + (index + 1) + '/' + total + '</text>' +
    '<text y="122" fill="#fff" font-family="Arial" font-size="42" font-weight="800" stroke="#07111f" stroke-width="5" paint-order="stroke">' + titleText + '</text>' +
    '<rect x="48" y="970" width="88" height="5" rx="2" fill="#67e8f9"/>' +
    '<text y="1030" fill="#fff" font-family="Arial" font-size="29" font-weight="700" stroke="#07111f" stroke-width="5" paint-order="stroke">' + captionText + '</text></svg>';
  await sharp(Buffer.from(svg)).png().toFile(output);
}

/**
 * sceneAssets: [{videoPath, narrationPath, soundEffectPath?}]
 * Music is optional. If provided, it is ducked under narrator audio.
 */
async function renderFilm(input) {
  const blueprint = input && input.blueprint;
  const sceneAssets = input && input.sceneAssets;
  const outputPath = input && input.outputPath;
  const musicPath = input && input.musicPath;
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable.");
  if (!blueprint || blueprint.format !== "ytagent.video-blueprint.v1") throw new Error("Unsupported blueprint format.");
  if (blueprint.duration_seconds !== DURATION || !Array.isArray(blueprint.scenes) || blueprint.scenes.length !== 10) {
    throw new Error("Expected ten shots on one 60-second timeline.");
  }
  if (!outputPath) throw new Error("An MP4 output path is required.");
  if (!Array.isArray(sceneAssets) || sceneAssets.length !== 10) throw new Error("Ten matching scene assets are required.");
  for (let i = 0; i < 10; i++) {
    const asset = sceneAssets[i];
    if (!asset || !asset.videoPath || !asset.narrationPath) {
      throw new Error("Shot " + (i + 1) + " has no narrator audio. Rendering is blocked.");
    }
    await Promise.all([fs.promises.access(asset.videoPath), fs.promises.access(asset.narrationPath)]);
  }
  if (musicPath) await fs.promises.access(musicPath);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const temp = await fs.promises.mkdtemp(path.join(path.dirname(outputPath), "ytagent-render-"));
  try {
    const args = ["-y", "-hide_banner", "-loglevel", "warning", "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1", "-probesize", "1M", "-analyzeduration", "1M"];
    const filters = [], videoLabels = [], voiceLabels = [], sfxLabels = [];
    let inputIndex = 0;
    for (let i = 0; i < 10; i++) {
      const asset = sceneAssets[i];
      const videoIndex = inputIndex++;
      const voiceIndex = inputIndex++;
      args.push("-stream_loop", "-1", "-i", asset.videoPath);
      args.push("-i", asset.narrationPath);
      let sfxIndex = -1;
      if (asset.soundEffectPath) {
        sfxIndex = inputIndex++;
        args.push("-i", asset.soundEffectPath);
      }
      const overlayIndex = inputIndex++;
      const overlayPath = path.join(temp, "overlay-" + i + ".png");
      await makeOverlay(blueprint.scenes[i], i, 10, overlayPath);
      args.push("-loop", "1", "-framerate", "30", "-i", overlayPath);
      const v = "v" + i, a = "a" + i;
      filters.push("[" + videoIndex + ":v]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,fps=24,setsar=1,trim=duration=6,setpts=PTS-STARTPTS[base" + i + "]");
      filters.push("[" + overlayIndex + ":v]scale=540:960[ov" + i + "]");
      filters.push("[base" + i + "][ov" + i + "]overlay=0:0:shortest=1,format=yuv420p[" + v + "]");
      filters.push("[" + voiceIndex + ":a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=6,asetpts=PTS-STARTPTS[" + a + "]");
      videoLabels.push("[" + v + "]");
      voiceLabels.push("[" + a + "]");
      if (sfxIndex >= 0) {
        const s = "s" + i;
        filters.push("[" + sfxIndex + ":a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.20,adelay=" + (i * 6000) + "|" + (i * 6000) + ",apad,atrim=duration=60,asetpts=PTS-STARTPTS[" + s + "]");
        sfxLabels.push("[" + s + "]");
      }
    }
    filters.push(videoLabels.join("") + "concat=n=10:v=1:a=0[vout]");
    filters.push(voiceLabels.join("") + "concat=n=10:v=0:a=1[voice]");
    if (sfxLabels.length) filters.push(sfxLabels.join("") + "amix=inputs=" + sfxLabels.length + ":duration=longest:normalize=0,atrim=duration=60[sfx]");
    if (musicPath) {
      const musicIndex = inputIndex;
      args.push("-stream_loop", "-1", "-i", musicPath);
      filters.push("[" + musicIndex + ":a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.16,atrim=duration=60,asetpts=PTS-STARTPTS[music]");
      filters.push("[music][voice]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=500[ducked]");
      if (sfxLabels.length) filters.push("[ducked][sfx]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.89[aout]");
      else filters.push("[ducked]alimiter=limit=0.89[aout]");
    } else if (sfxLabels.length) {
      filters.push("[voice][sfx]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.89[aout]");
    } else {
      filters.push("[voice]alimiter=limit=0.89[aout]");
    }
    args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]",
      "-t", "60", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath);
    await run(args);
    const stat = await fs.promises.stat(outputPath);
    if (stat.size < 100000) throw new Error("MP4 output failed the basic file-size quality check.");
    return { outputPath, duration_seconds: 60, resolution: "540x960", fps: 24, narrator_required: true, music_added: Boolean(musicPath), sound_effect_scenes: sfxLabels.length };
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { renderFilm };
