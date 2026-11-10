const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");

function cleanText(value, max = 240) {
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
    child.on("close", code => code === 0 ? resolve() : reject(new Error(error.slice(-1000) || "Video rendering failed.")));
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
function svgText(lines, x, y, size, lineHeight, weight = 700) {
  return '<text x="' + x + '" y="' + y + '" fill="#fff" font-family="Arial,sans-serif" font-size="' + size + '" font-weight="' + weight + '" stroke="#07111f" stroke-width="5" stroke-linejoin="round" paint-order="stroke">' +
    lines.map((line, i) => '<tspan x="' + x + '" dy="' + (i ? lineHeight : 0) + '">' + escapeXml(line) + '</tspan>').join("") + '</text>';
}

async function requestStoryboard(topic) {
  const prompt = `Create a factual, engaging 60-second vertical YouTube Shorts science explainer about: "${cleanText(topic, 180)}".
Return valid JSON only:
{"title":"hook title","description":"accurate short description","tags":["..."],"hashtags":["#..."],"keywords":["..."],"scenes":[{"title":"short scene heading","narration":"natural spoken narration, maximum 180 characters","caption":"short readable subtitle, maximum 11 words","visual_query":"specific real-world image search phrase for the main subject of this scene","visual_direction":"what the image should show"}]}.
Exactly 5 scenes. Each narration must be 18 to 24 words and no more than 180 characters. Total narration should be around 100 to 120 words. Use natural spoken English, no stage directions, no scene labels. Every visual_query must name a concrete subject that can be found in a real photograph or scientific image. No abstract graphics, UI, HUD, circles, grids, placeholder boxes, diagrams, text-only images, logos or watermarks. Keep science accurate. Build a strong opening, explain cause and effect, finish with a memorable takeaway.`;
  let geminiFailure = "";
  if (process.env.GEMINI_API_KEY) {
    try {
      const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.55 } })
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const raw = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
        if (raw) return JSON.parse(raw.replace(/^\u0060\u0060\u0060(?:json)?\s*/i, "").replace(/\s*\u0060\u0060\u0060$/, ""));
        geminiFailure = "Gemini returned an empty storyboard.";
      } else geminiFailure = "Gemini HTTP " + response.status + (data.error?.message ? ": " + String(data.error.message).slice(0, 180) : "");
    } catch (error) { geminiFailure = error.message || "Gemini request failed."; }
  } else geminiFailure = "Gemini API key is missing.";
  if (process.env.GROQ_API_KEY) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_SCRIPT_MODEL || "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: "You create accurate science video storyboards. Return valid JSON only. Follow every schema and visual restriction." },
          { role: "user", content: prompt }
        ],
        temperature: 0.55,
        max_completion_tokens: 2200,
        response_format: { type: "json_object" }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("Gemini was unavailable (" + geminiFailure + "). Groq storyboard failed: " + (data.error?.message || "HTTP " + response.status));
    const raw = data.choices?.[0]?.message?.content;
    if (raw) return JSON.parse(raw.replace(/^\u0060\u0060\u0060(?:json)?\s*/i, "").replace(/\s*\u0060\u0060\u0060$/, ""));
    throw new Error("Groq returned an empty storyboard.");
  }
  throw new Error("AI script generation failed: " + geminiFailure + ". Add GROQ_API_KEY in Railway Variables.");
}

async function findCommonsImage(query, fallbackQuery) {
  const searches = [query, fallbackQuery].filter(Boolean);
  for (const search of searches) {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    url.search = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: search + " filetype:bitmap",
      gsrnamespace: "6",
      gsrlimit: "8",
      prop: "imageinfo",
      iiprop: "url|extmetadata",
      iiurlwidth: "1200",
      format: "json"
    });
    const response = await fetch(url, { headers: { "User-Agent": "YTAgent/1.0 (educational video generator)" } });
    if (!response.ok) continue;
    const data = await response.json().catch(() => ({}));
    const pages = Object.values(data.query?.pages || {});
    const candidates = pages.map(page => {
      const info = page.imageinfo?.[0] || {};
      const meta = info.extmetadata || {};
      const read = key => String(meta[key]?.value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return {
        title: page.title || "",
        url: info.thumburl || info.url,
        description: read("ImageDescription"),
        artist: read("Artist"),
        license: read("LicenseShortName"),
        licenseUrl: read("LicenseUrl")
      };
    }).filter(item => item.url && /^https?:\/\//i.test(item.url));
    if (candidates.length) return candidates[0];
  }
  throw new Error("Could not find a usable real science image for: " + query + ". Try a more specific topic.");
}

async function downloadImage(url, outputPath) {
  const response = await fetch(url, { headers: { "User-Agent": "YTAgent/1.0 educational video renderer" } });
  if (!response.ok) throw new Error("A scene image could not be downloaded (HTTP " + response.status + ").");
  const type = response.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error("The image source returned a non-image file.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 18 * 1024 * 1024) throw new Error("A scene image was too large to process.");
  await sharp(buffer).rotate().resize(720, 1280, { fit: "cover", position: "attention" }).jpeg({ quality: 88 }).toFile(outputPath);
}

async function generateNarration(text, outputPath) {
  const narration = cleanText(text, 195);
  if (!narration) throw new Error("One scene is missing its narration.");
  if (process.env.GROQ_API_KEY) {
    const response = await fetch("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_TTS_MODEL || "canopylabs/orpheus-v1-english",
        input: narration,
        voice: process.env.GROQ_TTS_VOICE || "hannah",
        response_format: "wav"
      })
    });
    if (response.ok) {
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length > 1000) {
        await fs.promises.writeFile(outputPath, audio);
        return "Groq Orpheus";
      }
    } else {
      const detail = await response.text().catch(() => "");
      console.warn("Groq voice generation failed:", response.status, detail.slice(0, 220));
    }
  }
  try {
    const { EdgeTTS } = require("node-edge-tts");
    const tts = new EdgeTTS({
      voice: process.env.EDGE_TTS_VOICE || "en-US-AriaNeural",
      lang: "en-US",
      outputFormat: "audio-24khz-96kbitrate-mono-mp3",
      timeout: 30000
    });
    const mp3Path = outputPath.replace(/\.wav$/i, ".mp3");
    await tts.ttsPromise(narration, mp3Path);
    return { provider: "Microsoft Edge TTS", path: mp3Path };
  } catch (error) {
    throw new Error("Voice generation failed. Groq TTS was unavailable and the free voice fallback failed: " + (error.message || "unknown error"));
  }
}

function sceneArtwork(scene, index, total, credit) {
  const titleLines = wrapWords(scene.title || "A question worth asking", 22, 2);
  const captionLines = wrapWords(scene.caption || scene.title || "", 31, 3);
  const heading = svgText(titleLines, 48, 115, 43, 52, 800);
  const subtitle = svgText(captionLines, 48, 1040, 30, 39, 700);
  const creditText = escapeXml(credit ? "Image: " + credit : "YTAgent original edit");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280">
    <defs>
      <linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#020817" stop-opacity=".9"/><stop offset="1" stop-color="#020817" stop-opacity="0"/></linearGradient>
      <linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#020817" stop-opacity="0"/><stop offset=".3" stop-color="#020817" stop-opacity=".82"/><stop offset="1" stop-color="#020817" stop-opacity=".96"/></linearGradient>
    </defs>
    <rect width="720" height="290" fill="url(#top)"/>
    <rect y="820" width="720" height="460" fill="url(#bottom)"/>
    <text x="48" y="55" fill="#67e8f9" font-family="Arial,sans-serif" font-size="18" font-weight="700" letter-spacing="3">YT AGENT • WHAT IF? • ${index + 1}/${total}</text>
    ${heading}
    <rect x="48" y="970" width="88" height="5" rx="2" fill="#67e8f9"/>
    ${subtitle}
    <text x="48" y="1235" fill="#ffffff" opacity=".7" font-family="Arial,sans-serif" font-size="13">${creditText}</text>
  </svg>`);
}

function getMediaDuration(filePath) {
  return new Promise(resolve => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-i", filePath, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let output = "";
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.on("close", () => {
      const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 8);
    });
    child.on("error", () => resolve(8));
  });
}

async function generateEducationalVideo(topic, outputPath) {
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    throw new Error("Add GEMINI_API_KEY or GROQ_API_KEY in Railway Variables before generating videos.");
  }
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable on this server.");
  const storyboard = await requestStoryboard(topic);
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length !== 5) {
    throw new Error("The AI storyboard did not contain exactly five scenes. Please try again.");
  }
  for (const [index, scene] of storyboard.scenes.entries()) {
    if (!scene.narration || String(scene.narration).length > 195 || !scene.visual_query || !scene.caption) {
      throw new Error("Scene " + (index + 1) + " is missing required content or its narration exceeds the 195-character voice limit. Please regenerate.");
    }
  }

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-cinema-"));
  try {
    const clips = [];
    const voiceFiles = [];
    const credits = [];
    let voiceProvider = "Groq Orpheus";
    for (let i = 0; i < storyboard.scenes.length; i++) {
      const scene = storyboard.scenes[i];
      const image = await findCommonsImage(scene.visual_query, cleanText(topic, 100));
      const imagePath = path.join(workDir, "image-" + i + ".jpg");
      const artPath = path.join(workDir, "art-" + i + ".jpg");
      const audioPath = path.join(workDir, "voice-" + i + ".wav");
      const clipPath = path.join(workDir, "clip-" + i + ".mp4");
      await downloadImage(image.url, imagePath);
      const credit = [image.artist, image.license].filter(Boolean).join(" • ");
      credits.push({ source: image.title, artist: image.artist, license: image.license, license_url: image.licenseUrl });
      await sharp(imagePath).composite([{ input: sceneArtwork(scene, i, storyboard.scenes.length, credit), top: 0, left: 0 }]).jpeg({ quality: 90 }).toFile(artPath);

      const speech = await generateNarration(scene.narration, audioPath);
      let actualAudioPath = audioPath;
      if (typeof speech === "object") {
        voiceProvider = speech.provider;
        actualAudioPath = speech.path;
      } else voiceProvider = speech;

      const duration = Math.max(5, Math.min(18, await getMediaDuration(actualAudioPath)));
      voiceFiles.push(actualAudioPath);
      const frames = Math.max(120, Math.ceil(duration * 24));
      await run(ffmpegPath, [
        "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", "24", "-i", artPath,
        "-i", actualAudioPath,
        "-vf", "zoompan=z='min(zoom+0.00035,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=" + frames + ":s=720x1280:fps=24,format=yuv420p",
        "-t", String(duration), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24",
        "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", clipPath
      ]);
      clips.push(clipPath);
    }

    const concatPath = path.join(workDir, "clips.txt");
    await fs.promises.writeFile(concatPath, clips.map(file => "file '" + file.replace(/'/g, "'\\''") + "'").join("\n"));
    await run(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatPath,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", outputPath
    ]);

    const totalDuration = await getMediaDuration(outputPath);
    const description = cleanText(storyboard.description || "", 1000) +
      "\n\nImage credits (Wikimedia Commons):\n" +
      credits.map((item, i) => (i + 1) + ". " + item.source + (item.artist ? " — " + item.artist : "") + (item.license ? " (" + item.license + ")" : "") + (item.license_url ? " " + item.license_url : "")).join("\n");
    return {
      title: cleanText(storyboard.title || topic, 100),
      description,
      keywords: Array.isArray(storyboard.keywords) ? storyboard.keywords.map(String).slice(0, 12) : [],
      tags: Array.isArray(storyboard.tags) ? storyboard.tags.map(String).slice(0, 15) : [],
      hashtags: Array.isArray(storyboard.hashtags) ? storyboard.hashtags.map(String).slice(0, 5) : [],
      duration_seconds: Math.round(totalDuration),
      scenes: storyboard.scenes.length,
      format: "720x1280 vertical MP4",
      captions: "Burned into the video",
      narration: "Included",
      voice_provider: voiceProvider,
      visuals: "Five topic-matched Wikimedia Commons photographs with cinematic pan and zoom",
      image_credits: credits
    };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { generateEducationalVideo };
