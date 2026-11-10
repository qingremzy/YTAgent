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

async function requestStoryboard(topic) {
  const prompt = `Create a factual, high-retention 60-second vertical YouTube science explainer about: "${cleanText(topic, 180)}".
Return valid JSON only:
{"title":"hook title","description":"accurate short description","tags":["..."],"hashtags":["#..."],"keywords":["..."],"scenes":[{"title":"short heading","narration":"natural spoken narration","caption":"short subtitle","visual_direction":"precise description of the 3D scene, subject and action"}]}.
Exactly 10 scenes. Each narration must be 9 to 14 spoken words. Total narration should be 100 to 125 words. Each scene must show a different moment in a coherent visual story. Keep the main subject large and centered for a vertical 9:16 crop. The visual_direction must describe one concrete action that can be animated, not a static poster.
VISUAL QUALITY: premium cinematic 3D educational animation, extremely detailed physically based CGI, realistic materials and anatomy, believable scale and physics, dramatic cinematic lighting, volumetric atmosphere, depth of field, macro close-ups, dynamic camera angles, smooth camera movement, rich but natural colours. Think polished theatrical science documentary animation. Avoid flat illustrations, abstract glowing shapes, HUDs, diagrams, symbols, placeholder graphics, title cards, watermarks, or text inside the generated scene.
Be scientifically accurate. Build a powerful opening, clear cause and effect, escalating visual interest and a memorable ending. Do not imitate any creator's exact characters, scenes, branding or finished videos.`;
  let geminiFailure = "";
  if (process.env.GEMINI_API_KEY) {
    try {
      const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.65 } })
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const raw = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
        if (raw) return JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
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
          { role: "system", content: "You create accurate, cinematic 3D science video storyboards. Return valid JSON only and obey the exact schema." },
          { role: "user", content: prompt }
        ],
        temperature: 0.65,
        max_completion_tokens: 3600,
        response_format: { type: "json_object" }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("Gemini was unavailable (" + geminiFailure + "). Groq storyboard failed: " + (data.error?.message || "HTTP " + response.status));
    const raw = data.choices?.[0]?.message?.content;
    if (raw) return JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    throw new Error("Groq returned an empty storyboard.");
  }
  throw new Error("AI script generation failed: " + geminiFailure + ". Add GROQ_API_KEY in Railway Variables.");
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
