const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");
const { compileBlueprint } = require("./video-compiler/blueprint");
const { renderFilm } = require("./video-compiler/renderer");
const { generateSceneClips } = require("./video-providers/agnes");
const { generateWanSceneClips } = require("./video-providers/wan-worker");
const { generateRewindSceneClips } = require("./video-providers/rewind");
const { generateFallbackSceneClips } = require("./video-providers/free-visual-fallback");

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

function countNarrationWords(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean).length;
}

function validateStoryboard(storyboard) {
  if (!storyboard || typeof storyboard !== "object" || Array.isArray(storyboard)) throw new Error("Storyboard must be a JSON object.");
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length !== 10) throw new Error("Storyboard must contain exactly 10 scenes.");
  var seenNarration = new Set();
  for (var i = 0; i < storyboard.scenes.length; i++) {
    var scene = storyboard.scenes[i];
    if (!scene || !scene.narration || !scene.visual_direction || !scene.caption) throw new Error("Scene " + (i + 1) + " is missing narration, visual_direction or caption.");
    var narration = String(scene.narration).trim();
    if (narration.length > 220) throw new Error("Scene " + (i + 1) + " narration is too long for its six-second slot.");
    var wordCount = countNarrationWords(narration);
    if (wordCount < 8 || wordCount > 16) throw new Error("Scene " + (i + 1) + " narration has " + wordCount + " words. Use 8 to 16 words so the spoken line can fit its six-second scene.");
    var normalized = narration.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
    if (seenNarration.has(normalized)) throw new Error("Scene " + (i + 1) + " repeats narration from another scene. Every scene needs a distinct spoken line.");
    seenNarration.add(normalized);
  }
  ["tags", "hashtags", "keywords"].forEach(function(key) { if (!Array.isArray(storyboard[key])) storyboard[key] = []; });
  return storyboard;
}

async function requestStoryboard(topic) {
  var prompt = "Create an original, factual, high-retention 60-second vertical YouTube explainer about: \"" + cleanText(topic, 180) + "\".\n" +
    "Return ONE valid JSON object only. Required keys: title, description, tags, hashtags, keywords, scenes. Exactly 10 scenes. Every scene must contain title, narration, caption and visual_direction. " +
    "NARRATION IS THE PRIORITY: write a connected spoken explanation, not ten disconnected facts or poetic fragments. Each scene line must contain 12 to 16 natural spoken words. Across the ten lines, explain what is happening, why it happens, how it works, what changes next, and the surprising result. Use plain conversational English, specific nouns, active verbs, short transitions and useful facts. No filler, vague hype, repeated hooks, rhetorical padding or unexplained jargon. The narrator should sound like an engaging documentary presenter teaching one curious viewer. " +
    "STORY STRUCTURE: scene 1 opens with a surprising consequence or question; scenes 2-3 establish the subject; scenes 4-7 explain the mechanism step by step; scenes 8-9 reveal the consequence or twist; scene 10 delivers a memorable, accurate takeaway. Each scene must logically continue the previous one. " +
    "VISUAL DIRECTIONS: describe one specific visible action with a clear subject, physical object, setting and camera framing. Show the exact thing being explained at that moment. Prefer expressive 3D animated human characters, practical props, recognizable environments, close-ups, demonstrations and cause-and-effect actions. Keep recurring characters and key objects visually consistent across scenes. " +
    "Do not use abstract swirling lines, orbiting dots, atom-like patterns, floating particles, generic glowing shapes, decorative science backgrounds, random stock imagery, text cards or static illustrations unless the topic specifically requires that exact phenomenon. No repeated compositions. Keep the main action large and readable in vertical 9:16. " +
    "Be scientifically accurate. Make every visual directly illustrate its narration line. Do not imitate any creator's characters, scripts, scenes or branding.";
  var failures = [];
  if (process.env.GEMINI_API_KEY) {
    try {
      var model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
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
              { role: "user", content: prompt + (attempt ? "\nRETRY: The previous output failed validation. Return compact, complete valid JSON with exactly 10 scenes and no extra text." : "") }
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

async function requestGeneratedScenes(scenes, topic, workDir) {
  // Rewind is opt-in so a newly added API key cannot spend tokens unexpectedly.
  if (process.env.REWIND_VIDEO_ENABLED === "true" && process.env.REWIND_API_KEY) {
    try {
      const clips = await generateRewindSceneClips(scenes, topic, workDir);
      return { clips, provider: "Rewind AI" };
    } catch (error) {
      console.warn("Rewind video generation failed. Checking the free GPU worker:", error.message || error);
    }
  }

  // Agnes is attempted only when the user has explicitly confirmed a no-charge quota.
  if (process.env.AGNES_API_KEY && process.env.AGNES_FREE_QUOTA_CONFIRMED === "true") {
    try {
      const clips = await generateSceneClips(scenes, topic, workDir);
      return { clips, provider: "Agnes AI" };
    } catch (error) {
      console.warn("Agnes visual generation failed:", error.message || error);
    }
  }

  if (!process.env.VIDEO_WORKER_URL || !process.env.YT_AGENT_WORKER_TOKEN) {
    throw new Error("Real 3D video generation is unavailable. Enable Rewind after confirming its token cost, or start the free Kaggle GPU worker. YTAgent stopped instead of returning abstract artwork.");
  }

  try {
    const generated = await generateWanSceneClips(scenes, topic, workDir);
    if (Array.isArray(generated)) return { clips: generated, narrationClips: null, provider: "Wan 2.1 Free GPU Worker" };
    return { clips: generated.clips, narrationClips: generated.narrations, provider: "Wan 2.1 + Kokoro 82M Free GPU Worker" };
  } catch (error) {
    throw new Error("The real 3D video worker is unavailable: " + (error.message || error) + ". YTAgent stopped instead of returning abstract artwork.");
  }
}

function isGroqTtsEnabled(env = process.env) {
  return Boolean(env.GROQ_API_KEY && env.GROQ_TTS_ENABLED === "true");
}

function isRateLimitError(error) {
  return /\b429\b|too many requests|rate.?limit/i.test(String(error && error.message || error || ""));
}

function edgeTtsRetryDelayMs(attempt) {
  return Math.min(8000, 2000 * Math.pow(2, Math.max(0, attempt)));
}

function shouldAttemptGroqTts(voiceState = {}, env = process.env) {
  return isGroqTtsEnabled(env) && voiceState.groqRateLimited !== true;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function generateNarration(text, outputPath, voiceState = {}) {
  const narration = cleanText(text, 220);
  if (!narration) throw new Error("One scene is missing its narration.");
  if (shouldAttemptGroqTts(voiceState)) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/audio/speech", {
        method: "POST",
        headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.GROQ_TTS_MODEL || "canopylabs/orpheus-v1-english",
          input: narration,
          voice: process.env.GROQ_TTS_VOICE || "hannah",
          response_format: "wav"
        }),
        signal: AbortSignal.timeout(45000)
      });
      if (response.ok) {
        const audio = Buffer.from(await response.arrayBuffer());
        if (audio.length > 1000) {
          await fs.promises.writeFile(outputPath, audio);
          return { provider: "Groq Orpheus", path: outputPath };
        }
        console.warn("Groq voice generation returned an empty audio file. Trying the free voice fallback.");
      } else {
        const detail = await response.text().catch(() => "");
        console.warn("Groq voice generation failed:", response.status, detail.slice(0, 220));
        if (response.status === 429) voiceState.groqRateLimited = true;
      }
    } catch (error) {
      console.warn("Groq voice generation request failed. Trying the free voice fallback:", error.message || error);
    }
  }
  const { EdgeTTS } = require("node-edge-tts");
  const mp3Path = outputPath.replace(/\\.wav$/i, ".mp3");
  let edgeError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await wait(edgeTtsRetryDelayMs(attempt - 1));
      const tts = new EdgeTTS({
        voice: process.env.EDGE_TTS_VOICE || "en-US-ChristopherNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-96kbitrate-mono-mp3",
        timeout: 30000
      });
      await tts.ttsPromise(narration, mp3Path);
      return { provider: "Microsoft Edge TTS", path: mp3Path };
    } catch (error) {
      edgeError = error;
      if (!isRateLimitError(error) || attempt === 2) break;
      console.warn("Microsoft Edge TTS is rate-limiting requests. Retrying after a short delay.");
    }
  }
  throw new Error("Voice generation failed. Groq TTS may be rate-limited and Microsoft Edge TTS could not recover after retries: " + (edgeError && edgeError.message || "unknown error"));
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
      resolve(match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null);
    });
    child.on("error", () => resolve(null));
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

  // Convert the director's storyboard into the compiler's constrained film plan.
  const blueprint = compileBlueprint(storyboard, { language: "en", voiceId: process.env.EDGE_TTS_VOICE || "en-US-ChristopherNeural" });
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-film-"));
  try {
    // Agnes supplies five 12-second cinematic clips, which are split into ten scene plates.
    const visualResult = await requestGeneratedScenes(storyboard.scenes, topic, workDir);
    const generatedClips = visualResult.clips;
    const voiceProviders = new Set();
    const voiceState = {};
    const sceneAssets = [];
    for (let i = 0; i < storyboard.scenes.length; i++) {
      const audioPath = path.join(workDir, "narration-" + String(i + 1).padStart(2, "0") + ".wav");
      const speech = visualResult.narrationClips && visualResult.narrationClips[i]
        ? { provider: "Kokoro 82M (free local worker)", path: visualResult.narrationClips[i] }
        : await generateNarration(storyboard.scenes[i].narration, audioPath, voiceState);
      voiceProviders.add(speech.provider);
      // Measure the actual generated speech before rendering so six-second scenes never silently chop words.
      const speechDuration = await getMediaDuration(speech.path);
      if (!Number.isFinite(speechDuration) || speechDuration <= 0) {
        throw new Error("Could not measure narration audio for scene " + (i + 1) + ". The film was stopped to avoid cutting off speech.");
      }
      const audioTempo = Math.max(1, speechDuration / 6);
      if (audioTempo > 1.35) {
        throw new Error("Scene " + (i + 1) + " narration is too long (" + speechDuration.toFixed(1) + " seconds). Shorten the line and try again. YTAgent will not cut off spoken words.");
      }
      // The renderer applies only the small speed-up needed to fit the six-second slot.
      sceneAssets.push({ videoPath: generatedClips[i], narrationPath: speech.path, audioTempo });
    }

    const rendered = await renderFilm({ blueprint, sceneAssets, outputPath });
    const totalDuration = await getMediaDuration(outputPath);
    if (Math.abs(totalDuration - 60) > 1.5) {
      throw new Error("The rendered film did not pass the 60-second duration check.");
    }
    return {
      title: cleanText(storyboard.title || topic, 100),
      description: cleanText(storyboard.description || "", 1000) + "\n\nCreated with YTAgent's video compiler.",
      keywords: Array.isArray(storyboard.keywords) ? storyboard.keywords.map(String).slice(0, 12) : [],
      tags: Array.isArray(storyboard.tags) ? storyboard.tags.map(String).slice(0, 15) : [],
      hashtags: Array.isArray(storyboard.hashtags) ? storyboard.hashtags.map(String).slice(0, 5) : [],
      duration_seconds: Math.round(totalDuration),
      scenes: storyboard.scenes.length,
      format: "540x960 vertical MP4 (24 FPS)",
      captions: "Burned into the video (scene-level)",
      narration: "Included in every scene",
      voice_provider: Array.from(voiceProviders).join(" + "),
      visuals: visualResult.provider === "YTAgent Free Visual Fallback" ? "Ten animated artwork scenes assembled by the YTAgent video compiler" : "Ten AI-generated moving video scenes assembled by the YTAgent video compiler",
      visual_provider: visualResult.provider,
      compiler: rendered
    };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { generateEducationalVideo, isGroqTtsEnabled, shouldAttemptGroqTts, isRateLimitError, edgeTtsRetryDelayMs, validateStoryboard, countNarrationWords };
