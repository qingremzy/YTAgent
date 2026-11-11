const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");

function safe(value, max = 150) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function xml(value) {
  return safe(value, 180).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function wrap(value, maxChars, maxLines) {
  const words = safe(value, 180).split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else line = (line + " " + word).trim();
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}
function textBlock(value, x, y, size, lineHeight, maxChars, maxLines, weight) {
  return wrap(value, maxChars, maxLines).map((line, i) =>
    '<text x="' + x + '" y="' + (y + i * lineHeight) + '" fill="#f1f2f4" font-family="DejaVu Sans,Arial,sans-serif" font-size="' + size + '" font-weight="' + weight + '">' + xml(line) + '</text>'
  ).join("");
}
function sceneVisual(scene, index) {
  const words = ((scene && (scene.title || "") ) + " " + (scene && (scene.visual_direction || ""))).toLowerCase();
  const silver = "#d7dbe0", mid = "#aeb4bd", dim = "#737b86";
  if (/space|planet|star|moon|orbit|galaxy|solar|black hole|comet/.test(words)) {
    return '<g fill="none" stroke="' + mid + '" opacity=".72"><ellipse cx="360" cy="620" rx="235" ry="95" transform="rotate(-28 360 620)" stroke-width="3"/><ellipse cx="360" cy="620" rx="235" ry="95" transform="rotate(52 360 620)" stroke-width="3"/></g><circle cx="360" cy="620" r="78" fill="' + silver + '"/><circle cx="165" cy="520" r="18" fill="' + mid + '"/><circle cx="535" cy="695" r="24" fill="' + silver + '"/><circle cx="360" cy="525" r="10" fill="' + dim + '"/>';
  }
  if (/cell|biology|bacteria|virus|microbe|organism|dna|gene/.test(words)) {
    return '<circle cx="360" cy="620" r="205" fill="none" stroke="' + mid + '" stroke-width="8"/><circle cx="360" cy="620" r="172" fill="none" stroke="' + dim + '" stroke-width="3" stroke-dasharray="8 14"/><path d="M250 570 Q300 450 380 570 T490 650 Q420 790 300 700Z" fill="none" stroke="' + silver + '" stroke-width="12"/><circle cx="360" cy="620" r="54" fill="' + silver + '"/><g fill="' + mid + '">' + Array.from({length:12},(_,i)=>'<circle cx="'+(230+(i*67)%260)+'" cy="'+(490+(i*83)%260)+'" r="'+(7+i%4*3)+'"/>').join("") + '</g>';
  }
  if (/ocean|water|sea|wave|underwater|ice|river/.test(words)) {
    return '<g fill="none" stroke="' + silver + '" stroke-width="9" opacity=".8">' + [0,1,2,3,4].map(i=>'<path d="M95 '+(510+i*58)+' Q190 '+(440+i*58)+' 285 '+(510+i*58)+' T475 '+(510+i*58)+' T665 '+(510+i*58)+'"/>').join("") + '</g><circle cx="500" cy="390" r="65" fill="' + mid + '" opacity=".75"/><path d="M300 770 Q360 650 420 770" fill="none" stroke="' + dim + '" stroke-width="18"/>';
  }
  if (/plant|tree|leaf|forest|photosynth|flower|root/.test(words)) {
    return '<path d="M360 820 Q345 640 360 420" fill="none" stroke="' + silver + '" stroke-width="18"/>' + [0,1,2,3].map(i=>'<path d="M360 '+(690-i*72)+' Q'+(160+i*28)+' '+(640-i*65)+' '+(190+i*45)+' '+(480-i*35)+' Q'+(340+i*5)+' '+(490-i*30)+' 360 '+(690-i*72)+'" fill="none" stroke="'+mid+'" stroke-width="13"/>').join("") + '<path d="M360 820 Q270 900 200 930 M360 820 Q450 900 520 930" fill="none" stroke="' + dim + '" stroke-width="10"/>';
  }
  if (/brain|neuron|nerve|signal|electric|atom|electron|molecule|quantum/.test(words)) {
    const points = Array.from({length:11},(_,i)=>({x:150+(i*137)%420,y:440+(i*89)%360}));
    return '<g stroke="' + dim + '" stroke-width="7" opacity=".8">' + points.map((p,i)=>'<line x1="'+p.x+'" y1="'+p.y+'" x2="'+points[(i+3)%points.length].x+'" y2="'+points[(i+3)%points.length].y+'"/>').join("") + '</g><g fill="' + silver + '">' + points.map((p,i)=>'<circle cx="'+p.x+'" cy="'+p.y+'" r="'+(i%3===0?24:13)+'"/>').join("") + '</g>';
  }
  if (/human|heart|blood|body|lung|muscle|bone|organ/.test(words)) {
    return '<path d="M360 790 C300 710 160 610 220 500 C270 410 345 470 360 530 C390 450 485 420 530 510 C590 635 440 730 360 790Z" fill="none" stroke="' + silver + '" stroke-width="16"/><path d="M360 530 L360 760 M250 570 L360 640 L475 550" fill="none" stroke="' + mid + '" stroke-width="9"/>';
  }
  if (/fire|volcano|heat|lava|eruption|explosion/.test(words)) {
    return '<path d="M115 850 L260 570 L330 670 L430 430 L610 850Z" fill="none" stroke="' + silver + '" stroke-width="13"/><path d="M330 670 Q360 550 430 430 Q480 570 520 650" fill="none" stroke="' + mid + '" stroke-width="9"/><g fill="' + mid + '">' + [0,1,2,3,4,5].map(i=>'<circle cx="'+(250+i*48)+'" cy="'+(390+(i%3)*55)+'" r="'+(8+i%3*5)+'"/>').join("") + '</g>';
  }
  const variant = index % 3;
  if (variant === 0) return '<g fill="none" stroke="' + mid + '" stroke-width="9"><circle cx="360" cy="620" r="190"/><circle cx="360" cy="620" r="125"/><circle cx="360" cy="620" r="60"/></g><circle cx="360" cy="620" r="22" fill="' + silver + '"/>';
  if (variant === 1) return '<path d="M140 760 Q240 360 360 650 T580 470" fill="none" stroke="' + silver + '" stroke-width="18"/><path d="M140 820 Q280 540 420 760 T620 590" fill="none" stroke="' + mid + '" stroke-width="8"/><circle cx="360" cy="650" r="40" fill="' + silver + '"/>';
  return '<g fill="none" stroke="' + mid + '" stroke-width="8">' + [0,1,2,3,4].map(i=>'<polygon points="'+(360+Math.cos(i*1.256)*190)+','+(620+Math.sin(i*1.256)*190)+' '+(360+Math.cos((i+1)*1.256)*190)+','+(620+Math.sin((i+1)*1.256)*190)+' 360,620"/>').join("") + '</g><circle cx="360" cy="620" r="48" fill="' + silver + '"/>';
}
function buildFallbackArtwork(scene, index, total) {
  const title = scene && (scene.title || scene.caption) || "A closer look";
  const detail = scene && (scene.visual_direction || scene.caption) || "Explore the science";
  return '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">' +
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#08090b"/><stop offset=".52" stop-color="#24272d"/><stop offset="1" stop-color="#090a0c"/></linearGradient><radialGradient id="light"><stop stop-color="#aeb4bd" stop-opacity=".2"/><stop offset="1" stop-color="#090a0c" stop-opacity="0"/></radialGradient></defs>' +
    '<rect width="720" height="1280" fill="url(#bg)"/><circle cx="360" cy="620" r="330" fill="url(#light)"/>' +
    '<g opacity=".12" fill="#d7dbe0">' + Array.from({length:24},(_,i)=>'<circle cx="'+((i*137)%720)+'" cy="'+((i*211)%1280)+'" r="'+(2+i%3)+'"/>').join("") + '</g>' +
    '<g>' + sceneVisual(scene, index) + '</g>' +
    '<rect x="40" y="64" width="640" height="190" rx="28" fill="#090a0c" opacity=".86"/>' +
    '<text x="66" y="112" fill="#aeb4bd" font-family="DejaVu Sans,Arial,sans-serif" font-size="18" font-weight="700" letter-spacing="2">YT AGENT • SCENE ' + (index + 1) + '/' + total + '</text>' +
    textBlock(title, 66, 170, 32, 42, 31, 2, 800) +
    '<rect x="40" y="970" width="640" height="250" rx="28" fill="#090a0c" opacity=".9"/>' +
    '<text x="66" y="1030" fill="#aeb4bd" font-family="DejaVu Sans,Arial,sans-serif" font-size="18" font-weight="700" letter-spacing="1">WHAT TO NOTICE</text>' +
    textBlock(detail, 66, 1080, 22, 34, 47, 4, 500) +
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
module.exports = { buildFallbackArtwork, generateFallbackSceneClips, sceneVisual, wrap };
