const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");

function cleanText(value, max = 180) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function escapeXml(value) {
  return cleanText(value, 260).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => { error += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(error.slice(-900) || "Video rendering failed.")));
  });
}
function wrapWords(value, limit, maxLines) {
  const words = cleanText(value, 260).split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > limit && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else line = (line + " " + word).trim();
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[.,;:]?$/, "…");
  }
  return lines;
}
function svgLines(lines, x, y, fontSize, lineHeight, weight = 700) {
  return '<text x="' + x + '" y="' + y + '" fill="#ffffff" font-family="Arial,sans-serif" font-size="' + fontSize + '" font-weight="' + weight + '">' +
    lines.map((line, i) => '<tspan x="' + x + '" dy="' + (i ? lineHeight : 0) + '">' + escapeXml(line) + '</tspan>').join("") + '</text>';
}
function sceneSvg(scene, index, total) {
  const visual = escapeXml(scene.visual || "A cinematic abstract science illustration");
  const titleLines = wrapWords(scene.title || "A question worth asking", 19, 3);
  const captionLines = wrapWords(scene.caption || scene.title || "", 35, 4);
  const palettes = [
    ["#07152d", "#123d59", "#26a6a1"],
    ["#170f32", "#49265f", "#f0a35e"],
    ["#101d31", "#24536b", "#63c6dc"],
    ["#241329", "#66364f", "#f2b36f"],
    ["#081c28", "#17636a", "#8be0c4"]
  ];
  const [a, b, accent] = palettes[index % palettes.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="${accent}" stop-opacity=".8"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="38"/></filter>
  </defs>
  <rect width="720" height="1280" fill="url(#bg)"/>
  <circle cx="${index % 2 ? 545 : 150}" cy="380" r="250" fill="url(#glow)" filter="url(#blur)"/>
  <circle cx="${index % 2 ? 545 : 150}" cy="380" r="126" fill="none" stroke="${accent}" stroke-opacity=".55" stroke-width="2"/>
  <circle cx="${index % 2 ? 545 : 150}" cy="380" r="180" fill="none" stroke="#ffffff" stroke-opacity=".16" stroke-width="2" stroke-dasharray="8 16"/>
  <path d="M0 770 Q180 680 360 770 T720 760" fill="none" stroke="#ffffff" stroke-opacity=".14" stroke-width="2"/>
  <text x="54" y="110" fill="${accent}" font-family="Arial,sans-serif" font-size="22" font-weight="700" letter-spacing="5">YT AGENT • WHAT IF?</text>
  <text x="54" y="690" fill="#ffffff" font-family="Arial,sans-serif" font-size="24" opacity=".72">SCENE ${index + 1} / ${total}</text>
  ${svgLines(titleLines, 54, 805, 54, 62, 800)}
  <rect x="54" y="990" width="612" height="4" rx="2" fill="${accent}"/>
  ${svgLines(captionLines, 54, 1065, 29, 38, 500)}
  <text x="54" y="1235" fill="#ffffff" opacity=".48" font-family="Arial,sans-serif" font-size="17">${visual}</text>
  </svg>`;
}

async function requestStoryboard(prompt) {
  let geminiFailure = null;

  if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.65 } })
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const raw = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
        if (raw) return JSON.parse(raw.replace(/^\u0060\u0060\u0060(?:json)?\\s*/i, "").replace(/\\s*\u0060\u0060\u0060$/, ""));
        throw new Error("Gemini returned an empty storyboard.");
      }
      geminiFailure = "Gemini HTTP " + response.status + (data.error?.message ? ": " + String(data.error.message).slice(0, 240) : "");
    } catch (error) {
      geminiFailure = error.message || "Gemini request failed.";
    }
  } else {
    geminiFailure = "Gemini API key is not configured.";
  }

  if (process.env.GROQ_API_KEY) {
    const model = process.env.GROQ_SCRIPT_MODEL || "openai/gpt-oss-20b";
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You create accurate educational science video storyboards. Return valid JSON only, with no markdown." },
          { role: "user", content: prompt }
        ],
        temperature: 0.65,
        max_completion_tokens: 1800,
        response_format: { type: "json_object" }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data.error?.message ? String(data.error.message).slice(0, 220) : "HTTP " + response.status;
      throw new Error("Gemini was unavailable (" + geminiFailure + ") and Groq fallback failed (" + detail + "). Check the API quota/key in Railway Variables.");
    }
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Gemini was unavailable and Groq returned an empty storyboard.");
    try {
      return JSON.parse(raw.replace(/^\u0060\u0060\u0060(?:json)?\\s*/i, "").replace(/\\s*\u0060\u0060\u0060$/, ""));
    } catch {
      throw new Error("The AI provider returned invalid storyboard JSON. Please try again.");
    }
  }

  if (geminiFailure.includes("429")) {
    throw new Error("Gemini's free API quota/rate limit has been reached, and GROQ_API_KEY is missing. Add or check GROQ_API_KEY in Railway Variables, then redeploy.");
  }
  throw new Error("AI script generation failed: " + geminiFailure + (process.env.GROQ_API_KEY ? " Groq fallback could not be used." : " Add GROQ_API_KEY in Railway Variables for fallback."));
}

async function generateEducationalVideo(topic, outputPath) {
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    throw new Error("Add GEMINI_API_KEY or GROQ_API_KEY in Railway Variables before generating videos.");
  }
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable on this server.");
  const prompt = `Create an original, accurate, 60-second educational science/what-if YouTube Shorts storyboard about: "${cleanText(topic, 180)}".
Return JSON only: {"title":"short hook","description":"one-paragraph factual summary","scenes":[{"title":"short on-screen heading","caption":"subtitle/caption text, 12-22 words","visual":"short visual direction"}]}.
Exactly 5 scenes. Each caption should be clear, factual, concise and readable. Build a strong hook, explain the sequence, and finish with a memorable takeaway. Do not invent scientific facts. No logos, no copyrighted characters, no fake quotations. Each scene represents about 12 seconds. The video will be rendered as animated motion-graphic scenes with burned-in captions, not photorealistic footage.`;
  let storyboard;
  try {
    storyboard = await requestStoryboard(prompt);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("AI returned invalid storyboard JSON. Please try again.");
    throw error;
  }
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length !== 5) throw new Error("AI storyboard must contain exactly five scenes.");

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-render-"));
  try {
    const segmentPaths = [];
    for (let i = 0; i < storyboard.scenes.length; i++) {
      const scene = storyboard.scenes[i];
      const pngPath = path.join(workDir, "scene-" + i + ".png");
      const segmentPath = path.join(workDir, "segment-" + i + ".mp4");
      await sharp(Buffer.from(sceneSvg(scene, i, storyboard.scenes.length))).png().toFile(pngPath);
      await run(ffmpegPath, [
        "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "24", "-i", pngPath,
        "-vf", "zoompan=z='min(zoom+0.00045,1.13)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=288:s=720x1280:fps=24,format=yuv420p",
        "-frames:v", "288", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "27", segmentPath
      ]);
      segmentPaths.push(segmentPath);
    }
    const listPath = path.join(workDir, "concat.txt");
    await fs.promises.writeFile(listPath, segmentPaths.map(file => "file '" + file.replace(/'/g, "'\\''") + "'").join("\\n"));
    await run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outputPath]);
    return {
      title: cleanText(storyboard.title || topic, 100),
      description: cleanText(storyboard.description || "", 1200),
      duration_seconds: 60,
      scenes: storyboard.scenes.length,
      format: "720x1280 vertical MP4",
      captions: "Burned into the video"
    };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { generateEducationalVideo };
