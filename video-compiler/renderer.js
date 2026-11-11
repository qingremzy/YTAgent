/**
 * Low-memory FFmpeg renderer for YTAgent's structured 60-second film plan.
 * Renders one six-second scene at a time, then concatenates the finished segments.
 * This avoids keeping ten video decoders, ten overlays and the full audio graph
 * alive in one FFmpeg process (the previous cause suspected for Railway SIGKILLs).
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const { verifyRenderedVideo } = require("./quality-check");
const ffmpegPath = require("ffmpeg-static");
const WIDTH = 540, HEIGHT = 960, FPS = 24, SCENE_SECONDS = 6, SCENE_COUNT = 10;
const DURATION = SCENE_SECONDS * SCENE_COUNT;

function clean(value, max) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max || 200);
}
function xml(value) {
  return clean(value, 220).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function run(args, label) {
  return new Promise((resolve, reject) => {
    let settled = false, stderr = "", child;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    try {
      child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      finish(new Error((label || "FFmpeg") + " could not start: " + (error.message || String(error))));
      return;
    }
    if (child.stderr) child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-5000);
    });
    child.once("error", error => finish(new Error((label || "FFmpeg") + " process error: " + (error.message || String(error)))));
    child.once("close", (code, signal) => {
      if (code === 0) return finish();
      const reason = signal ? "terminated by signal " + signal : "exited with code " + String(code);
      const detail = stderr.trim() || "No FFmpeg diagnostics. The host may have stopped the process due to resource limits.";
      finish(new Error((label || "FFmpeg render") + " failed (" + reason + "): " + detail.slice(-3500)));
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
  const titleText = title.map((line, i) => '<tspan x="36" dy="' + (i ? 42 : 0) + '">' + xml(line) + "</tspan>").join("");
  const captionText = caption.map((line, i) => '<tspan x="36" dy="' + (i ? 31 : 0) + '">' + xml(line) + "</tspan>").join("");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + HEIGHT + '">' +
    '<defs><linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#090a0c" stop-opacity=".9"/><stop offset="1" stop-color="#090a0c" stop-opacity="0"/></linearGradient>' +
    '<linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#090a0c" stop-opacity="0"/><stop offset=".3" stop-color="#090a0c" stop-opacity=".84"/><stop offset="1" stop-color="#090a0c" stop-opacity=".97"/></linearGradient></defs>' +
    '<rect width="' + WIDTH + '" height="230" fill="url(#top)"/><rect y="615" width="' + WIDTH + '" height="345" fill="url(#bottom)"/>' +
    '<text x="36" y="45" fill="#d7dbe0" font-family="Arial" font-size="15" font-weight="700" letter-spacing="2">YT AGENT • ' + (index + 1) + '/' + total + '</text>' +
    '<text y="100" fill="#fff" font-family="Arial" font-size="34" font-weight="800" stroke="#090a0c" stroke-width="4" paint-order="stroke">' + titleText + '</text>' +
    '<rect x="36" y="730" width="66" height="4" rx="2" fill="#d7dbe0"/>' +
    '<text y="780" fill="#fff" font-family="Arial" font-size="24" font-weight="700" stroke="#090a0c" stroke-width="4" paint-order="stroke">' + captionText + '</text></svg>';
  await sharp(Buffer.from(svg)).png().toFile(output);
}
function concatEscape(file) {
  return String(file).replace(/'/g, "'\\''");
}
async function renderScene(asset, scene, index, temp) {
  const overlayPath = path.join(temp, "overlay-" + index + ".png");
  const segmentPath = path.join(temp, "segment-" + String(index).padStart(2, "0") + ".mp4");
  await makeOverlay(scene, index, SCENE_COUNT, overlayPath);
  const args = [
    "-y", "-hide_banner", "-loglevel", "warning",
    "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1",
    "-probesize", "512k", "-analyzeduration", "500k",
    "-stream_loop", "-1", "-i", asset.videoPath,
    "-i", asset.narrationPath,
    "-loop", "1", "-framerate", String(FPS), "-i", overlayPath
  ];
  let sfxIndex = -1;
  if (asset.soundEffectPath) {
    sfxIndex = 3;
    args.push("-i", asset.soundEffectPath);
  }
  const filters = [
    "[0:v]scale=" + WIDTH + ":" + HEIGHT + ":force_original_aspect_ratio=increase,crop=" + WIDTH + ":" + HEIGHT + ",fps=" + FPS + ",setsar=1,trim=duration=" + SCENE_SECONDS + ",setpts=PTS-STARTPTS[base]",
    "[2:v]scale=" + WIDTH + ":" + HEIGHT + "[ov]",
    "[base][ov]overlay=0:0:shortest=1,format=yuv420p[vout]",
    "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=" + SCENE_SECONDS + ",asetpts=PTS-STARTPTS[voice]"
  ];
  if (sfxIndex >= 0) {
    filters.push("[" + sfxIndex + ":a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.20,apad,atrim=duration=" + SCENE_SECONDS + ",asetpts=PTS-STARTPTS[sfx]");
    filters.push("[voice][sfx]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.89[aout]");
  } else {
    filters.push("[voice]alimiter=limit=0.89[aout]");
  }
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-t", String(SCENE_SECONDS), "-r", String(FPS),
    "-threads", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart", segmentPath
  );
  await run(args, "Scene " + (index + 1) + " render");
  const stat = await fs.promises.stat(segmentPath);
  if (stat.size < 10000) throw new Error("Scene " + (index + 1) + " render produced an incomplete segment.");
  return segmentPath;
}
async function renderFilmUnlocked(input) {
  const blueprint = input && input.blueprint;
  const sceneAssets = input && input.sceneAssets;
  const outputPath = input && input.outputPath;
  const musicPath = input && input.musicPath;
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable.");
  if (!blueprint || blueprint.format !== "ytagent.video-blueprint.v1") throw new Error("Unsupported blueprint format.");
  if (blueprint.duration_seconds !== DURATION || !Array.isArray(blueprint.scenes) || blueprint.scenes.length !== SCENE_COUNT) {
    throw new Error("Expected ten shots on one 60-second timeline.");
  }
  if (!outputPath) throw new Error("An MP4 output path is required.");
  if (!Array.isArray(sceneAssets) || sceneAssets.length !== SCENE_COUNT) throw new Error("Ten matching scene assets are required.");
  for (let i = 0; i < SCENE_COUNT; i++) {
    const asset = sceneAssets[i];
    if (!asset || !asset.videoPath || !asset.narrationPath) throw new Error("Shot " + (i + 1) + " has no narrator audio. Rendering is blocked.");
    await Promise.all([fs.promises.access(asset.videoPath), fs.promises.access(asset.narrationPath)]);
    if (asset.soundEffectPath) await fs.promises.access(asset.soundEffectPath);
  }
  if (musicPath) await fs.promises.access(musicPath);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const temp = await fs.promises.mkdtemp(path.join(path.dirname(outputPath), "ytagent-render-"));
  try {
    const segments = [];
    // Deliberately sequential: only one video decoder/filter graph/encoder is alive at once.
    for (let i = 0; i < SCENE_COUNT; i++) {
      segments.push(await renderScene(sceneAssets[i], blueprint.scenes[i], i, temp));
    }
    const concatList = path.join(temp, "segments.txt");
    await fs.promises.writeFile(concatList, segments.map(file => "file '" + concatEscape(file) + "'").join("\n") + "\n");
    const joinedPath = musicPath ? path.join(temp, "joined-no-music.mp4") : outputPath;
    await run([
      "-y", "-hide_banner", "-loglevel", "warning", "-threads", "1",
      "-f", "concat", "-safe", "0", "-i", concatList,
      "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", joinedPath
    ], "Scene concatenation");
    if (musicPath) {
      await run([
        "-y", "-hide_banner", "-loglevel", "warning", "-threads", "1", "-filter_threads", "1",
        "-i", joinedPath, "-stream_loop", "-1", "-i", musicPath,
        "-filter_complex",
        "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.16,atrim=duration=60,asetpts=PTS-STARTPTS[music];[music][0:a]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=500[ducked];[ducked]alimiter=limit=0.89[aout]",
        "-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        "-t", "60", "-movflags", "+faststart", outputPath
      ], "Background music mix");
    }
    const stat = await fs.promises.stat(outputPath);
    if (stat.size < 100000) throw new Error("MP4 output failed the basic file-size quality check.");
    const quality = await verifyRenderedVideo(outputPath);
    return { outputPath, duration_seconds: quality.duration_seconds, resolution: WIDTH + "x" + HEIGHT, fps: FPS, narrator_required: true, music_added: Boolean(musicPath), sound_effect_scenes: sceneAssets.filter(asset => asset.soundEffectPath).length, render_strategy: "sequential-scene-render-and-concat", quality_check: quality };
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
// Serialize renders in-process so two user jobs cannot multiply FFmpeg peak memory.
let renderQueue = Promise.resolve();
function renderFilm(input) {
  const task = renderQueue.then(() => renderFilmUnlocked(input));
  renderQueue = task.catch(() => {});
  return task;
}
module.exports = { renderFilm };
