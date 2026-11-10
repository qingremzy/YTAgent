const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const AdmZip = require("adm-zip");
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
    child.on("close", code => code === 0 ? resolve() : reject(new Error(error.slice(-1200) || "Video rendering failed.")));
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


function parseStoryboardJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("The AI returned an empty response.");
  var text = raw.trim();
  if (text.slice(0, 3) === "```") {
    var lineEnd = text.indexOf("\n");
    text = lineEnd >= 0 ? text.slice(lineEnd + 1) : text.slice(3);
  }
  if (text.slice(-3) === "```") text = text.slice(0, -3).trim();
  try { return JSON.parse(text); } catch (_) {}
  var first = text.indexOf("{");
  if (first < 0) throw new Error("No JSON object was found in the AI response.");
  var depth = 0, quoted = false, escaped = false;
  for (var i = first; i < text.length; i++) {
    var ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch.charCodeAt(0) === 92) escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(first, i + 1));
  }
  throw new Error("The AI response contained incomplete JSON.");
}

function validateStoryboard(storyboard) {
  if (!storyboard || typeof storyboard !== "object" || Array.isArray(storyboard)) throw new Error("Storyboard must be a JSON object.");
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length !== 10) throw new Error("Storyboard must contain exactly 10 scenes.");
  for (var i = 0; i < storyboard.scenes.length; i++) {
    var scene = storyboard.scenes[i];
    if (!scene || !scene.narration || !scene.visual_direction || !scene.caption) throw new Error("Scene " + (i + 1) + " is missing narration, visual_direction or caption.");
  }
  ["tags", "hashtags", "keywords"].forEach(function(key) { if (!Array.isArray(storyboard[key])) storyboard[key] = []; });
  return storyboard;
}

async function requestStoryboard(topic) {
  var prompt = "Create a factual, high-retention 60-second vertical YouTube science explainer about: \"" + cleanText(topic, 180) + "\".\n" +
    "Return ONE valid JSON object only. No markdown, commentary or extra text. Required keys: title, description, tags, hashtags, keywords, scenes. " +
    "Exactly 10 scenes. Every scene must contain title, narration, caption and visual_direction. Each narration should be 9 to 14 spoken words. " +
    "Each visual_direction must describe one concrete, animatable action. Keep the subject large and centered for vertical 9:16. " +
    "Use premium cinematic realistic 3D educational CGI, physically based materials, believable anatomy and physics, dramatic lighting, volumetric atmosphere, macro detail and smooth camera movement. " +
    "Be scientifically accurate. Build a strong hook, clear cause and effect, escalating visual interest and memorable ending. Do not imitate any creator's characters, scenes or branding.";
  var failures = [];
  if (process.env.GEMINI_API_KEY) {
    try {
      var model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
      var response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.4 } }),
        signal: AbortSignal.timeout(45000)
      });
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok) failures.push("Gemini HTTP " + response.status + (data.error && data.error.message ? ": " + String(data.error.message).slice(0, 180) : ""));
      else {
        var raw = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts ? data.candidates[0].content.parts.map(function(part) { return part.text || ""; }).join("") : "";
        try { return validateStoryboard(parseStoryboardJson(raw)); }
        catch (error) { failures.push("Gemini response: " + error.message); }
      }
    } catch (error) { failures.push("Gemini: " + (error.message || "request failed")); }
  } else failures.push("Gemini API key is missing.");

  if (process.env.GROQ_API_KEY) {
    var configuredModel = process.env.GROQ_SCRIPT_MODEL || "openai/gpt-oss-20b";
    var models = [configuredModel, "llama-3.3-70b-versatile"].filter(function(model, index, all) { return all.indexOf(model) === index; });
    for (var attempt = 0; attempt < 2; attempt++) {
      var groqModel = models[Math.min(attempt, models.length - 1)];
      try {
        var groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: groqModel,
            messages: [
              { role: "system", content: "You are a strict JSON API. Output exactly one complete JSON object matching the schema. No markdown, explanations or trailing commas. Include exactly ten scenes." },
              { role: "user", content: prompt + (attempt ? "\\nRETRY: The previous output failed validation. Return compact, complete valid JSON with exactly 10 scenes and no extra text." : "") }
            ],
            temperature: attempt ? 0.2 : 0.4,
            max_completion_tokens: 5000,
            response_format: { type: "json_object" }
          }),
          signal: AbortSignal.timeout(60000)
        });
        var groqData = await groqResponse.json().catch(function() { return {}; });
        if (!groqResponse.ok) {
          var errorDetail = groqData.error && (groqData.error.failed_generation || groqData.error.message) || "HTTP " + groqResponse.status;
          failures.push("Groq (" + groqModel + "): " + String(errorDetail).slice(0, 260));
          continue;
        }
        var groqRaw = groqData.choices && groqData.choices[0] && groqData.choices[0].message ? groqData.choices[0].message.content : "";
        try { return validateStoryboard(parseStoryboardJson(groqRaw)); }
        catch (error) { failures.push("Groq (" + groqModel + "): " + error.message); }
      } catch (error) { failures.push("Groq (" + groqModel + "): " + (error.message || "request failed")); }
    }
  } else failures.push("Groq API key is missing.");
  throw new Error("Storyboard generation failed. " + failures.join(" | "));
}

function buildVideoPrompt(scene, topic, index) {
  return cleanText(
    "Premium cinematic 3D science documentary animation. Topic: " + topic + ". " +
    "Shot " + (index + 1) + ". " + scene.visual_direction + ". " +
    "Photorealistic high-end CGI, detailed physically based materials, realistic scale and physics, believable motion, cinematic volumetric lighting, atmospheric depth, macro lens detail, shallow depth of field, dramatic camera push-in and smooth tracking movement. " +
    "One continuous coherent action, no cuts, no text, no labels, no logos, no watermarks. Main subject large and centered, composed safely for a vertical 9:16 crop.",
    1750
  );
}

async function requestGeneratedScenes(scenes, topic, workDir) {
  const baseUrl = String(process.env.VIDEO_WORKER_URL || "").replace(/\/+$/, "");
  const token = process.env.YT_AGENT_WORKER_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("The cinematic AI engine is not connected yet. Start the free Kaggle GPU worker and add VIDEO_WORKER_URL plus YT_AGENT_WORKER_TOKEN in Railway Variables. YTAgent will not fall back to the old photo slideshow.");
  }
  const headers = { "Authorization": "Bearer " + token, "Content-Type": "application/json" };
  const startResponse = await fetch(baseUrl + "/generate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      seed: Math.floor(Math.random() * 2000000000),
      scenes: scenes.map((scene, index) => ({ prompt: buildVideoPrompt(scene, topic, index) }))
    }),
    signal: AbortSignal.timeout(60000)
  });
  const started = await startResponse.json().catch(() => ({}));
  if (!startResponse.ok || !started.job_id) {
    throw new Error("Free GPU worker could not start: " + (started.detail || started.error || "HTTP " + startResponse.status));
  }
  const jobId = started.job_id;
  const deadline = Date.now() + 90 * 60 * 1000;
  let lastMessage = "Free GPU worker accepted the video.";
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10000));
    const statusResponse = await fetch(baseUrl + "/jobs/" + encodeURIComponent(jobId), {
      headers: { "Authorization": "Bearer " + token },
      signal: AbortSignal.timeout(30000)
    });
    const status = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) throw new Error("Could not check the GPU generation job: " + (status.detail || "HTTP " + statusResponse.status));
    lastMessage = status.message || lastMessage;
    if (status.status === "failed") throw new Error("Wan video generation failed: " + lastMessage);
    if (status.status === "completed") {
      const download = await fetch(baseUrl + "/jobs/" + encodeURIComponent(jobId) + "/download", {
        headers: { "Authorization": "Bearer " + token },
        signal: AbortSignal.timeout(120000)
      });
      if (!download.ok) throw new Error("The GPU worker finished but its scene archive could not be downloaded.");
      const zip = new AdmZip(Buffer.from(await download.arrayBuffer()));
      const entries = zip.getEntries().filter(entry => /^scene-\d{2}\.mp4$/.test(entry.entryName)).sort((a, b) => a.entryName.localeCompare(b.entryName));
      if (entries.length !== scenes.length) throw new Error("The GPU worker returned " + entries.length + " scenes. Expected " + scenes.length + ".");
      const clips = [];
      for (let i = 0; i < entries.length; i++) {
        const destination = path.join(workDir, "generated-scene-" + i + ".mp4");
        await fs.promises.writeFile(destination, entries[i].getData());
        clips.push(destination);
      }
      return clips;
    }
  }
  throw new Error("The free GPU worker took longer than 90 minutes. Last status: " + lastMessage + ". Check whether the Kaggle session is still running.");
}

async function generateNarration(text, outputPath) {
  const narration = cleanText(text, 220);
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
        return { provider: "Groq Orpheus", path: outputPath };
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
    throw new Error("Voice generation failed. Groq TTS and the free voice fallback were unavailable: " + (error.message || "unknown error"));
  }
}

function sceneArtwork(scene, index, total) {
  const titleLines = wrapWords(scene.title || "A question worth asking", 22, 2);
  const captionLines = wrapWords(scene.caption || scene.title || "", 31, 3);
  const heading = svgText(titleLines, 48, 115, 43, 52, 800);
  const subtitle = svgText(captionLines, 48, 1040, 30, 39, 700);
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
    <text x="48" y="1235" fill="#ffffff" opacity=".7" font-family="Arial,sans-serif" font-size="13">AI-GENERATED 3D SCENE</text>
  </svg>`);
}

function getMediaDuration(filePath) {
  return new Promise(resolve => {
    const child = spawn(ffmpegPath, ["-hide_banner", "-i", filePath, "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
    let output = "";
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.on("close", () => {
      const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 6);
    });
    child.on("error", () => resolve(6));
  });
}

async function generateEducationalVideo(topic, outputPath) {
  if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    throw new Error("Add GEMINI_API_KEY or GROQ_API_KEY in Railway Variables before generating videos.");
  }
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable on this server.");
  const storyboard = await requestStoryboard(topic);
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length !== 10) {
    throw new Error("The AI director must return exactly ten scenes. Please regenerate.");
  }
  for (const [index, scene] of storyboard.scenes.entries()) {
    if (!scene.narration || String(scene.narration).length > 220 || !scene.visual_direction || !scene.caption) {
      throw new Error("Scene " + (index + 1) + " is missing its narration, caption or visual direction. Please regenerate.");
    }
  }

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-wan-cinema-"));
  try {
    const generatedClips = await requestGeneratedScenes(storyboard.scenes, topic, workDir);
    const clips = [];
    const voiceProviders = new Set();
    for (let i = 0; i < storyboard.scenes.length; i++) {
      const scene = storyboard.scenes[i];
      const audioPath = path.join(workDir, "voice-" + i + ".wav");
      const speech = await generateNarration(scene.narration, audioPath);
      voiceProviders.add(speech.provider);
      const duration = Math.max(4, Math.min(12, await getMediaDuration(speech.path)));
      const overlayPath = path.join(workDir, "overlay-" + i + ".png");
      await sharp(sceneArtwork(scene, i, storyboard.scenes.length)).png().toFile(overlayPath);
      const clipPath = path.join(workDir, "final-scene-" + i + ".mp4");
      await run(ffmpegPath, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-stream_loop", "-1", "-i", generatedClips[i],
        "-i", overlayPath, "-i", speech.path,
        "-filter_complex", "[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1[bg];[bg][1:v]overlay=0:0,format=yuv420p[v]",
        "-map", "[v]", "-map", "2:a", "-t", String(duration),
        "-r", "24", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22",
        "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", clipPath
      ]);
      clips.push(clipPath);
    }
    const concatPath = path.join(workDir, "clips.txt");
    await fs.promises.writeFile(concatPath, clips.map(file => "file '" + file.replace(/'/g, "'\\''") + "'").join("\n"));
    await run(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatPath,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", outputPath
    ]);

    const totalDuration = await getMediaDuration(outputPath);
    return {
      title: cleanText(storyboard.title || topic, 100),
      description: cleanText(storyboard.description || "", 1000) + "\n\nCreated with YTAgent using the open Wan 2.1 text-to-video model.",
      keywords: Array.isArray(storyboard.keywords) ? storyboard.keywords.map(String).slice(0, 12) : [],
      tags: Array.isArray(storyboard.tags) ? storyboard.tags.map(String).slice(0, 15) : [],
      hashtags: Array.isArray(storyboard.hashtags) ? storyboard.hashtags.map(String).slice(0, 5) : [],
      duration_seconds: Math.round(totalDuration),
      scenes: storyboard.scenes.length,
      format: "720x1280 vertical MP4",
      captions: "Burned into the video",
      narration: "Included",
      voice_provider: Array.from(voiceProviders).join(" + "),
      visuals: "Ten AI-generated moving 3D scenes using Wan 2.1 T2V 1.3B"
    };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { generateEducationalVideo };
