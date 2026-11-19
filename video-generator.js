const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
const ffmpegPath = require("ffmpeg-static");
const { compileBlueprint } = require("./video-compiler/blueprint");
const { renderFilm } = require("./video-compiler/renderer");
const { generateSceneClips, generateSingleAgnesClip } = require("./video-providers/agnes");
const { generateLtxSceneClips } = require("./video-providers/huggingface-ltx");
const { generateSeedanceSceneClips, isSeedanceEligible } = require("./video-providers/seedance");
const { generateWanSceneClips } = require("./video-providers/wan-worker");
const { generateFallbackSceneClips } = require("./video-providers/free-visual-fallback");
const { createStudioProject } = require("./studio-project");

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

function validateStoryboard(storyboard, expectedScenes = 10) {
  if (!storyboard || typeof storyboard !== "object" || Array.isArray(storyboard)) throw new Error("Storyboard must be a JSON object.");
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length !== expectedScenes) throw new Error("Storyboard must contain exactly " + expectedScenes + " scenes.");
  var seenNarration = new Set();
  var seenVisualDirections = new Set();
  for (var i = 0; i < storyboard.scenes.length; i++) {
    var scene = storyboard.scenes[i];
    if (!scene || !scene.narration || !scene.visual_direction || !scene.caption) throw new Error("Scene " + (i + 1) + " is missing narration, visual_direction or caption.");
    var narration = String(scene.narration).trim();
    if (narration.length > 320) throw new Error("Scene " + (i + 1) + " narration is too long for its ten-second slot.");
    var wordCount = countNarrationWords(narration);
    if (wordCount < 8 || wordCount > 25) throw new Error("Scene " + (i + 1) + " narration has " + wordCount + " words. Use 8 to 25 words so the spoken line can fit its ten-second scene.");
    var normalized = narration.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
    if (seenNarration.has(normalized)) throw new Error("Scene " + (i + 1) + " repeats narration from another scene. Every scene needs a distinct spoken line.");
    seenNarration.add(normalized);
    var visualDirection = String(scene.visual_direction).trim();
    var visualWords = visualDirection.split(/\s+/).filter(Boolean).length;
    if (visualWords < 12 || visualWords > 45) throw new Error("Scene " + (i + 1) + " visual_direction must contain 12 to 45 specific words describing a physical action and setting.");
    var normalizedVisual = visualDirection.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
    if (seenVisualDirections.has(normalizedVisual)) throw new Error("Scene " + (i + 1) + " repeats a visual direction. Every scene needs a distinct action or composition.");
    seenVisualDirections.add(normalizedVisual);
  }
  ["tags", "hashtags", "keywords"].forEach(function(key) { if (!Array.isArray(storyboard[key])) storyboard[key] = []; });
  return storyboard;
}

async function requestStoryboard(topic, durationSeconds = 60) {
  var sceneCount = Number(durationSeconds) / 10;
  var prompt = "Act as the What-If Story production director shown in the reference workflow. Create an original, visually executable " + durationSeconds + "-second vertical animated short based on this selected idea: \"" + cleanText(topic, 180) + "\". The film is 9:16 and contains exactly " + sceneCount + " consecutive ten-second clips.\n" +
    "Follow these production stages internally and return ONE valid JSON object only. Required keys: title, description, tags, hashtags, keywords, continuity_guide, narrator_script, thumbnail_prompt, scenes. Exactly " + sceneCount + " scenes. Every scene must contain title, narration, caption and visual_direction.\n" +
    "STAGE 1 — FORMAT: plan for a complete " + durationSeconds + "-second vertical 9:16 short, split into " + sceneCount + " consecutive 10-second scene beats.\n" +
    "STAGE 2 — IDEA: preserve the selected premise and its central events. Build an imaginative what-if story around a strange everyday discovery, unusual rule, mysterious object or unexpected consequence. Do not change the selected premise.\n" +
    "STAGE 3 — PLAN AND GENERATION PROMPTS: first create a compact continuity_guide describing each character's face, hair silhouette, exact clothing colors, proportions and identifiers; the location's layout, palette, lighting direction and key props; and the story's cause-and-effect rule. Keep all character designs, props, spatial positions and lighting consistent between scenes. Then write " + sceneCount + " detailed visual_direction prompts, one per 10-second scene. Every prompt must state the exact character appearance, physical action, environment, props, camera framing/movement and the scene's opening/ending pose. Every scene must continue from the previous scene using the same character and environment descriptions. Preserve the exact visual bible. The current text-only provider route cannot accept a previous-frame image reference, so do not claim image-conditioned continuity.\n" +
    "VISUAL STYLE: flat 2D illustrated animation characters composited into a fully dimensional, shaded stylized 3D environment. Characters must remain flat illustrated cels: solid simple faces, bold outlines, flat clothing colors and thin line limbs. Do NOT turn them into 3D figurines, spherical skulls, sculpted cheeks, cylindrical limbs or realistic humans. Shade only the environment and props with perspective, material texture, directional light and cinematic depth. Make physical actions clear and readable.\n" +
    "STAGE 4 — NARRATOR SCRIPT: write one connected spoken story in narrator_script and split it naturally across the " + sceneCount + " scene narration fields. Each scene narration should fit its ten-second beat, move the plot forward and synchronize with visible action. Give voice direction (emotion, pace, emphasis and pauses) in narrator_script. No filler or repeated exposition.\n" +
    "STORY STRUCTURE: immediate visual hook; introduce protagonist and desire; establish the strange rule; escalate through visible consequences; deliver a surprising turn or honest choice; finish with a satisfying visual payoff. Make the ending feel complete.\n" +
    "STAGE 5 — UPLOAD PACK: provide a curiosity-driven accurate title, a copy-ready YouTube description, relevant tags, keywords, hashtags and a detailed vertical 9:16 thumbnail_prompt showing the story's strongest visual moment. The thumbnail prompt must specify composition, character appearance, expression, props, background and focal hierarchy. Do not invent channel analytics or claim research that was not performed.\n" +
    "SCENES: exactly " + sceneCount + " sequential scenes. Every visual_direction must be 18 to 45 specific words and describe a physical action rather than an abstract concept. No text cards, slideshows, watermarks, generic stock imagery or random unrelated visuals. Do not imitate any creator's characters, scripts, scenes or branding. Return JSON only.";
  // Strict $0 mode: walk only providers/models with a genuine free tier.
  // No trial-credit services, paid endpoints, or paid fallbacks are permitted.
  if (process.env.YTAGENT_ZERO_COST_MODE !== "false") {
    var freeFailures = [];
    var freeCandidates = [];
    var configuredOpenRouterModel = process.env.OPENROUTER_SCRIPT_MODEL || "openrouter/free";
    if (process.env.OPENROUTER_API_KEY) {
      var openRouterModels = [configuredOpenRouterModel, "openrouter/free",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "nvidia/nemotron-3.5-super-vl:free",
        "nvidia/nemotron-3.5-lightning:free",
        "google/gemma-4-31b-it:free",
        "recursive/flint-v1.0:free",
        "cohere/north-mini-code:free",
        "baidu/ernie-5.5-flash-preview:free",
        "thinkingmachines/inkling-2-small:free",
        "liquid/lfm-3-1.7b:free"];
      openRouterModels.filter(function(model, index, all) {
        return (model === "openrouter/free" || /:free$/.test(model)) && all.indexOf(model) === index;
      }).forEach(function(model) {
        freeCandidates.push({ name: "OpenRouter " + model, run: async function() {
          var response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": "Bearer " + process.env.OPENROUTER_API_KEY, "Content-Type": "application/json",
              "HTTP-Referer": process.env.APP_URL || "https://ytagent-production-1038.up.railway.app", "X-Title": "YTAgent" },
            body: JSON.stringify({ model: model, messages: [
              { role: "system", content: "Return exactly one valid JSON object. No markdown. Include exactly " + sceneCount + " scenes and follow every schema and storytelling constraint." },
              { role: "user", content: prompt }
            ], temperature: 0.2, max_tokens: 8000, response_format: { type: "json_object" } }),
            signal: AbortSignal.timeout(60000)
          });
          var data = await response.json().catch(function() { return {}; });
          if (!response.ok) throw new Error("HTTP " + response.status + ": " + String(data.error && data.error.message || "request failed").slice(0, 220));
          var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          if (Array.isArray(content)) content = content.map(function(part) { return typeof part === "string" ? part : part && (part.text || part.content) || ""; }).join("");
          if (typeof content !== "string" || !content.trim()) throw new Error("empty response");
          return parseStoryboardJson(content);
        }});
      });
    } else freeFailures.push("OpenRouter key missing");

    // Groq free plan models have published hard rate limits and stop at quota.
    // Try multiple models in sequence, without upgrading or switching to paid endpoints.
    if (process.env.GROQ_API_KEY) {
      var groqModels = (process.env.GROQ_SCRIPT_MODELS || [process.env.GROQ_SCRIPT_MODEL || "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"].join(",")).split(",").map(function(model) { return model.trim(); }).filter(Boolean);
      groqModels.forEach(function(model) {
        freeCandidates.push({ name: "Groq free " + model, run: async function() {
          var response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST", headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ model: model,
              messages: [{ role: "system", content: "Return exactly one valid JSON object. No markdown. Include exactly " + sceneCount + " scenes." }, { role: "user", content: prompt }],
              temperature: 0.2, max_completion_tokens: 8000, response_format: { type: "json_object" } }),
            signal: AbortSignal.timeout(60000)
          });
          var data = await response.json().catch(function() { return {}; });
          if (!response.ok) throw new Error("HTTP " + response.status + ": " + String(data.error && data.error.message || "request failed").slice(0, 220));
          var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          if (typeof content !== "string" || !content.trim()) throw new Error("empty response");
          return parseStoryboardJson(content);
        }});
      });
    } else freeFailures.push("Groq key missing");

    // Gemini is opt-in only when the Google project has billing disabled.
    // Multiple free-tier model IDs are attempted, each as an independent fallback.
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_FREE_TIER_ONLY === "true") {
      var geminiModels = (process.env.GEMINI_FREE_MODELS || [process.env.GEMINI_MODEL || "gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash"].join(",")).split(",").map(function(model) { return model.trim(); }).filter(Boolean);
      geminiModels.forEach(function(model) {
        freeCandidates.push({ name: "Gemini free " + model, run: async function() {
          var response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
            method: "POST", headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 8000 } }),
            signal: AbortSignal.timeout(60000)
          });
          var data = await response.json().catch(function() { return {}; });
          if (!response.ok) throw new Error("HTTP " + response.status + ": " + String(data.error && data.error.message || "request failed").slice(0, 220));
          var content = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
            ? data.candidates[0].content.parts.map(function(part) { return part.text || ""; }).join("") : "";
          if (!content.trim()) throw new Error("empty response");
          return parseStoryboardJson(content);
        }});
      });
    } else if (process.env.GEMINI_API_KEY) freeFailures.push("Gemini skipped because GEMINI_FREE_TIER_ONLY is not true");

    // Prefer Groq's free-plan endpoint for lower latency, then OpenRouter's free pool.
    // Gemini stays last and is only present when explicitly enabled for a billing-disabled project.
    function freeProviderRank(candidate) {
      if (candidate.name.indexOf("Groq free ") === 0) return 0;
      if (candidate.name.indexOf("OpenRouter ") === 0) return 1;
      if (candidate.name.indexOf("Gemini free ") === 0) return 2;
      return 3;
    }
    freeCandidates.sort(function(a, b) { return freeProviderRank(a) - freeProviderRank(b); });

    for (var candidate of freeCandidates) {
      console.log("YTAgent trying free story director:", candidate.name);
      try {
        var candidateStoryboard = validateStoryboard(await candidate.run(), sceneCount);
        console.log("YTAgent free story director succeeded:", candidate.name);
        return candidateStoryboard;
      } catch (error) {
        freeFailures.push(candidate.name + ": " + String(error.message || error).slice(0, 260));
        console.warn("YTAgent free story director fallback:", candidate.name, error.message || error);
      }
    }
    throw new Error("All configured free story directors failed. " + freeFailures.join(" | ") +
      ". No paid provider or paid fallback was attempted. Add optional free-tier provider keys or retry after quota reset.");
  }
  var failures = [];
  if (process.env.GEMINI_API_KEY) {
    try {
      var model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
      var response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.4 } }),
        signal: AbortSignal.timeout(30000)
      });
      var data = await response.json().catch(function() { return {}; });
      if (!response.ok) failures.push("Gemini HTTP " + response.status + (data.error && data.error.message ? ": " + String(data.error.message).slice(0, 180) : ""));
      else {
        var raw = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts ? data.candidates[0].content.parts.map(function(part) { return part.text || ""; }).join("") : "";
        try { return validateStoryboard(parseStoryboardJson(raw), sceneCount); }
        catch (error) { failures.push("Gemini response: " + error.message); }
      }
    } catch (error) { failures.push("Gemini: " + (error.message || "request failed")); }
  } else failures.push("Gemini API key is missing.");

  if (process.env.GROQ_API_KEY) {
    var configuredModel = process.env.GROQ_SCRIPT_MODEL || "openai/gpt-oss-20b";
    var models = [configuredModel, "openai/gpt-oss-20b"].filter(function(model, index, all) { return all.indexOf(model) === index; });
    for (var attempt = 0; attempt < 2; attempt++) {
      var groqModel = models[Math.min(attempt, models.length - 1)];
      try {
        var groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: groqModel,
            messages: [
              { role: "system", content: "You are a strict JSON API. Output exactly one complete JSON object matching the schema. No markdown, explanations or trailing commas. Include exactly " + sceneCount + " scenes." },
              { role: "user", content: prompt + (attempt ? "\nRETRY: The previous output failed validation. Return compact, complete valid JSON with exactly 10 scenes and no extra text." : "") }
            ],
            temperature: attempt ? 0.2 : 0.4,
            max_completion_tokens: 8000,
            response_format: { type: "json_object" }
          }),
          signal: AbortSignal.timeout(40000)
        });
        var groqData = await groqResponse.json().catch(function() { return {}; });
        if (!groqResponse.ok) {
          var errorDetail = groqData.error && (groqData.error.failed_generation || groqData.error.message) || "HTTP " + groqResponse.status;
          failures.push("Groq (" + groqModel + "): " + String(errorDetail).slice(0, 260));
          continue;
        }
        var groqRaw = groqData.choices && groqData.choices[0] && groqData.choices[0].message ? groqData.choices[0].message.content : "";
        try { return validateStoryboard(parseStoryboardJson(groqRaw), sceneCount); }
        catch (error) { failures.push("Groq (" + groqModel + "): " + error.message); }
      } catch (error) { failures.push("Groq (" + groqModel + "): " + (error.message || "request failed")); }
    }
  } else failures.push("Groq API key is missing.");

  // OpenRouter is an optional free-model fallback. Its free-model router changes
  // over time, so keep the model configurable rather than pinning a retired model.
  if (process.env.OPENROUTER_API_KEY) {
    var openRouterModel = process.env.OPENROUTER_SCRIPT_MODEL || "openai/gpt-oss-20b:free";
    try {
      var openRouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + process.env.OPENROUTER_API_KEY,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL || "https://ytagent-production-1038.up.railway.app",
          "X-Title": "YTAgent"
        },
        body: JSON.stringify({
          model: openRouterModel,
          messages: [
            { role: "system", content: "Return exactly one valid JSON object. No markdown or commentary. Include exactly " + sceneCount + " scenes and follow every schema and storytelling constraint." },
            { role: "user", content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 8000,
          reasoning: { effort: "low" },
          response_format: { type: "json_object" }
        }),
        signal: AbortSignal.timeout(60000)
      });
      var openRouterData = await openRouterResponse.json().catch(function() { return {}; });
      if (!openRouterResponse.ok) {
        var openRouterError = openRouterData.error && openRouterData.error.message || "HTTP " + openRouterResponse.status;
        failures.push("OpenRouter (" + openRouterModel + "): " + String(openRouterError).slice(0, 240));
      } else {
        var openRouterMessage = openRouterData.choices && openRouterData.choices[0] && openRouterData.choices[0].message ? openRouterData.choices[0].message : {};
        var openRouterContent = openRouterMessage.content;
        var openRouterRaw = typeof openRouterContent === "string" ? openRouterContent : Array.isArray(openRouterContent) ? openRouterContent.map(function(part) { return typeof part === "string" ? part : part && (part.text || part.content) || ""; }).join("") : "";
        if (!openRouterRaw.trim()) {
          var finishReason = openRouterData.choices && openRouterData.choices[0] ? openRouterData.choices[0].finish_reason : "unknown";
          var selectedModel = openRouterData.model || openRouterModel;
          var providerError = openRouterData.error && openRouterData.error.message ? openRouterData.error.message : "";
          failures.push("OpenRouter (" + selectedModel + "): empty response (finish_reason=" + finishReason + ")" + (providerError ? " " + String(providerError).slice(0, 180) : ""));
        } else {
          try { return validateStoryboard(parseStoryboardJson(openRouterRaw), sceneCount); }
          catch (error) { failures.push("OpenRouter (" + (openRouterData.model || openRouterModel) + "): " + error.message); }
        }
      }
    } catch (error) {
      failures.push("OpenRouter (" + openRouterModel + "): " + (error.message || "request failed"));
    }
  } else failures.push("OpenRouter API key is not configured.");

  throw new Error("Storyboard generation failed. " + failures.join(" | "));
}

async function generateTutorialClips(scenes, topic, workDir, onProgress = () => {}, continuityGuide = "") {
  const confirmed = ["true", "1", "yes", "confirmed", "on"].includes(String(process.env.AGNES_FREE_QUOTA_CONFIRMED || "").trim().toLowerCase());
  if (!process.env.AGNES_API_KEY || !confirmed || (process.env.AGNES_VIDEO_MODEL || "agnes-video-2.5-flash") !== "agnes-video-2.5-flash") {
    throw new Error("The 10-second clip engine is not enabled with confirmed free quota. Set AGNES_API_KEY, AGNES_VIDEO_MODEL=agnes-video-2.5-flash and AGNES_FREE_QUOTA_CONFIRMED=true only after verifying that the provider account has free quota. No paid provider was contacted.");
  }
  const clips = [];
  let previousDirection = "";
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const prompt = [
      "Generate one complete ten-second vertical 9:16 animated video clip. Flat 2D illustrated characters composited into a fully dimensional, shaded stylized 3D environment. Characters remain flat illustrated cels with simple faces, bold dark outlines, thin line limbs and flat clothing colors. Never use realistic humans, 3D character models, slideshows or text cards.",
      "Story premise: " + cleanText(topic, 180),
      "Continuity bible: " + cleanText(continuityGuide, 1200),
      "This is clip " + (i + 1) + " of " + scenes.length + ".",
      "Previous clip ending/action context: " + cleanText(previousDirection || "Opening shot.", 500),
      "Current action and camera: " + cleanText(scene.visual_direction, 900),
      "Preserve exact character silhouette, face, hair, clothing colors, props, spatial layout, palette and lighting. Continue the same action and world. Do not add titles, captions, logos or watermarks."
    ].join("\n");
    const destination = path.join(workDir, "tutorial-clip-" + String(i + 1).padStart(2, "0") + ".mp4");
    await generateSingleAgnesClip(prompt, destination, 10, {
      timeoutMs: Number(process.env.AGNES_CLIP_TIMEOUT_MS || 12 * 60 * 1000),
      onProgress: (status, progress) => {
        try { onProgress(6 + Math.round(((i + Math.max(0, Number(progress) || 0) / 100) / scenes.length) * 80), "Generating ten-second clip " + (i + 1) + " of " + scenes.length + " (" + (status || "working") + ")."); } catch (_) {}
      }
    });
    clips.push(destination);
    previousDirection = scene.visual_direction;
  }
  return { clips, narrationClips: null, provider: "Agnes Video 2.5 Flash (confirmed free quota)" };
}

async function requestGeneratedScenes(scenes, topic, workDir, onProgress, onGpuJobQueued) {
  const seedanceRequested = ["true", "1", "yes", "on"].includes(String(process.env.ARK_SEEDANCE_ENABLED || "").trim().toLowerCase());
  if (isSeedanceEligible(process.env)) {
    const clips = await generateSeedanceSceneClips(scenes, topic, workDir, onProgress);
    return { clips, narrationClips: null, provider: "BytePlus ModelArk Dreamina Seedance 2.5" };
  }
  if (seedanceRequested) {
    console.warn("YTAgent skipped paid Seedance and will continue with free video providers. No paid API request was submitted.");
  }

  // First try the primary Agnes 2.5 + LTX six-beat route.
  let hostedRouteError = null;
  try {
    const { generateMultiProviderTimelineClips } = require("./video-providers/multi-provider-orchestrator");
    return await generateMultiProviderTimelineClips(scenes, topic, workDir, onProgress);
  } catch (error) {
    hostedRouteError = error;
    console.warn("Primary hosted video route unavailable:", error.message || error);
  }

  // Optional adapter based on uglylee/free-video-generator. It calls the
  // legacy Agnes Video v2.0 API directly. It shares Agnes infrastructure, so
  // never retry it when the primary Agnes route reports queue/capacity failure.
  try {
    const { isCapacityUnavailable } = require("./video-providers/multi-provider-orchestrator");
    const { generateAgnesV2TimelineClips, enabled } = require("./video-providers/agnes-v2-free-generator");
    if (enabled(process.env.AGNES_V2_FALLBACK_ENABLED) &&
        enabled(process.env.AGNES_V2_FREE_QUOTA_CONFIRMED) &&
        !isCapacityUnavailable(hostedRouteError)) {
      const generated = await generateAgnesV2TimelineClips(scenes, topic, workDir, onProgress);
      return { clips: generated.clips, narrationClips: null, provider: generated.provider };
    }
  } catch (error) {
    console.warn("Optional Agnes v2.0 fallback unavailable:", error.message || error);
  }

  // YumCut is an independent optional full-project fallback. Its adapter
  // fails closed unless the user explicitly enables it, confirms licensing,
  // supplies a token cap, and the API quotes a cost within that cap.
  try {
    const { generateYumCutSceneClips } = require("./video-providers/yumcut");
    if (process.env.YUMCUT_FALLBACK_ENABLED === "true") {
      const generated = await generateYumCutSceneClips(scenes, topic, workDir, onProgress);
      return { clips: generated.clips, narrationClips: null, provider: generated.provider };
    }
  } catch (error) {
    console.warn("Optional YumCut fallback unavailable:", error.message || error);
  }

  // The self-hosted Kaggle Wan worker remains the final GPU fallback.
  if (!process.env.YT_AGENT_WORKER_TOKEN) {
    throw new Error("All configured hosted video routes were unavailable. " +
      String(hostedRouteError && hostedRouteError.message || "Primary video generation failed.").slice(0, 400) +
      ". The Kaggle Wan fallback is not configured.");
  }
  try {
    const generated = await generateWanSceneClips(scenes, topic, workDir, onProgress, onGpuJobQueued);
    if (Array.isArray(generated)) return { clips: generated, narrationClips: null, provider: "Wan 2.1 Free GPU Worker" };
    return { clips: generated.clips, narrationClips: generated.narrations, provider: "Wan 2.1 + Kokoro 82M Free GPU Worker" };
  } catch (error) {
    throw new Error("All free video providers were unavailable: " + (error.message || error));
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

async function generateNarration(text, outputPath) {
  // Microsoft Edge's online neural TTS is the free no-key narration route.
  // Keep this independent from Kaggle so Agnes-generated scenes can finish
  // as a complete narrated Short without a GPU notebook.
  const { EdgeTTS } = require("node-edge-tts");
  const voice = process.env.EDGE_TTS_VOICE || "en-US-ChristopherNeural";
  const tts = new EdgeTTS({
    voice,
    lang: "en-US",
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
    rate: "+3%",
    timeout: 45000
  });
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await tts.ttsPromise(String(text || "").trim(), outputPath);
      const stat = await fs.promises.stat(outputPath);
      if (stat.size < 1000) throw new Error("Edge TTS returned an empty narration file.");
      return { provider: "Microsoft Edge neural TTS (free)", path: outputPath };
    } catch (error) {
      lastError = error;
      await fs.promises.unlink(outputPath).catch(() => {});
      if (attempt === 0) await wait(edgeTtsRetryDelayMs(attempt));
    }
  }
  throw new Error("Free narration generation failed: " + (lastError?.message || "Edge TTS unavailable"));
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

async function generateEducationalVideo(topic, outputPath, onProgress = () => {}, options = {}) {
  const durationSeconds = Number(options.durationSeconds === undefined ? 60 : options.durationSeconds);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 600 || durationSeconds % 10 !== 0) throw new Error("Choose a duration from 30 to 600 seconds in 10-second increments.");
  const sceneCount = durationSeconds / 10;
  let lastProgress = 0;
  const reportProgress = (progress, message) => {
    const value = Math.max(lastProgress, Math.max(0, Math.min(99, Number(progress) || 0)));
    lastProgress = value;
    try {
      const result = onProgress(value, message);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {}
  };
  if (process.env.YTAGENT_ZERO_COST_MODE !== "false" && !process.env.OPENROUTER_API_KEY && !process.env.GROQ_API_KEY && !(process.env.GEMINI_API_KEY && process.env.GEMINI_FREE_TIER_ONLY === "true")) {
    throw new Error("Zero-cost mode needs at least one configured free story director: OpenRouter free, Groq Free, or Gemini AI Studio Free with billing disabled.");
  }
  if (process.env.YTAGENT_ZERO_COST_MODE === "false" && !process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    throw new Error("Configure an AI director key before generating videos.");
  }
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable on this server.");
  reportProgress(2, "AI director is researching the topic and writing the story.");
  const storyboard = await requestStoryboard(topic, durationSeconds);
  reportProgress(5, "Storyboard approved. Preparing " + sceneCount + " matched ten-second clips.");
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length !== sceneCount) {
    throw new Error("The AI director must return exactly " + sceneCount + " scenes. Please regenerate.");
  }
  for (const [index, scene] of storyboard.scenes.entries()) {
    if (!scene.narration || String(scene.narration).length > 320 || !scene.visual_direction || !scene.caption) {
      throw new Error("Scene " + (index + 1) + " is missing its narration, caption or visual direction. Please regenerate.");
    }
  }

  // Convert the director's storyboard into the compiler's constrained film plan.
  const blueprint = compileBlueprint(storyboard, { durationSeconds, language: "en", voiceId: process.env.EDGE_TTS_VOICE || "en-US-ChristopherNeural" });
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-film-"));
  try {
    // The tutorial workflow requires one native ten-second generated clip per storyboard beat.
    // This route fails closed unless Agnes free quota has been explicitly confirmed in Railway.
    const visualResult = await generateTutorialClips(storyboard.scenes, topic, workDir, reportProgress, storyboard.continuity_guide);
    reportProgress(92, "All visuals and narration are ready. Mixing the film.");
    const generatedClips = visualResult.clips;
    const voiceProviders = new Set();
    const voiceState = {};
    const sceneAssets = [];
    for (let i = 0; i < storyboard.scenes.length; i++) {
      const audioPath = path.join(workDir, "narration-" + String(i + 1).padStart(2, "0") + ".mp3");
      const speech = visualResult.narrationClips && visualResult.narrationClips[i]
        ? { provider: "Kokoro 82M (free local worker)", path: visualResult.narrationClips[i] }
        : await generateNarration(storyboard.scenes[i].narration, audioPath);
      voiceProviders.add(speech.provider);
      // Measure the actual generated speech before rendering so ten-second scenes never silently chop words.
      const speechDuration = await getMediaDuration(speech.path);
      if (!Number.isFinite(speechDuration) || speechDuration <= 0) {
        throw new Error("Could not measure narration audio for scene " + (i + 1) + ". The film was stopped to avoid cutting off speech.");
      }
      const audioTempo = Math.max(1, speechDuration / 10);
      if (audioTempo > 1.35) {
        throw new Error("Scene " + (i + 1) + " narration is too long (" + speechDuration.toFixed(1) + " seconds). Shorten the line and try again. YTAgent will not cut off spoken words.");
      }
      // The renderer applies only the small speed-up needed to fit the ten-second slot.
      sceneAssets.push({ videoPath: generatedClips[i], narrationPath: speech.path, audioTempo });
      if (!visualResult.narrationClips) reportProgress(92 + Math.round((i + 1) * 0.25), "Creating narration track " + (i + 1) + " of 10.");
    }

    reportProgress(97, "Editing " + sceneCount + " scenes, captions and narration into one film.");
    const rendered = await renderFilm({ blueprint, sceneAssets, outputPath });
    reportProgress(99, "Running the final MP4 quality check.");
    const totalDuration = await getMediaDuration(outputPath);
    if (Math.abs(totalDuration - durationSeconds) > 1.5) {
      throw new Error("The rendered film did not pass the " + durationSeconds + "-second duration check.");
    }
    let studioProject = null;
    if (options.studioProjectRoot) {
      const match = path.basename(outputPath).match(/^generated-([a-f0-9]{24})\.mp4$/i);
      if (!match) throw new Error("Could not associate the finished film with its editable studio project.");
      try {
        const studioSceneAssets = await Promise.all(sceneAssets.map(async (asset, index) => {
          const narrationPath = path.join(workDir, "studio-narration-" + String(index + 1).padStart(2, "0") + ".wav");
          await run(ffmpegPath, [
            "-y", "-hide_banner", "-loglevel", "error", "-i", asset.narrationPath,
            "-af", "atempo=" + Number(asset.audioTempo).toFixed(3),
            "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", narrationPath
          ]);
          return { ...asset, narrationPath };
        }));
        studioProject = await createStudioProject({
          projectId: match[1],
          title: storyboard.title || topic,
          storyboard,
          sceneAssets: studioSceneAssets,
          rootDir: options.studioProjectRoot
        });
      } catch (error) {
        console.warn("The film rendered, but its editable studio copy could not be saved:", error.message);
      }
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
      continuity_guide: cleanText(storyboard.continuity_guide || "", 4000),
      narrator_script: cleanText(storyboard.narrator_script || "", 4000),
      thumbnail_prompt: cleanText(storyboard.thumbnail_prompt || "", 1800),
      scene_prompts: storyboard.scenes.map((scene, index) => ({ index: index + 1, prompt: cleanText(scene.visual_direction, 900), narration: cleanText(scene.narration, 320) })),
      visuals: visualResult.provider === "YTAgent Free Visual Fallback" ? "Ten animated artwork scenes assembled by the YTAgent video compiler" : "Ten AI-generated moving video scenes assembled by the YTAgent video compiler",
      visual_provider: visualResult.provider,
      studioProjectId: studioProject?.id || null,
      studioProjectUrl: studioProject ? "/api/studio/projects/" + studioProject.id : null,
      compiler: rendered
    };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { generateEducationalVideo, isGroqTtsEnabled, shouldAttemptGroqTts, isRateLimitError, edgeTtsRetryDelayMs, validateStoryboard, countNarrationWords, requestStoryboard };
