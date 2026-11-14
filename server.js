require("dotenv").config();
const express = require("express");
const session = require("express-session");
const { RedisStore } = require("connect-redis");
const helmet = require("helmet");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { google } = require("googleapis");
const { Queue, Worker } = require("bullmq");
const IORedis = require("ioredis");
const { createRateLimiter } = require("./middleware/rate-limit");
const { readStudioProject, saveStudioProject, validateStudioSource, resolveStudioAsset } = require("./studio-project");
const { createObjectStorage } = require("./object-storage");
const { createKaggleWorkerSessionManager } = require("./kaggle-worker-session");
const { listKaggleTools, callKaggleTool } = require("./kaggle-mcp");
const { validateNotebookSource, buildNotebookSaveRequest } = require("./kaggle-notebook");
const { pushNotebookWithKaggleCli, getKaggleKernelStatus, getKaggleQuota } = require("./kaggle-cli");
const { claimNextGpuJob, noteGpuWorkerPoll, getGpuWorkerStatus, updateGpuJobProgress, receiveGpuScene, receiveGpuAudio, failGpuJob } = require("./gpu-worker-bridge");

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 3000);
const redisEnabled = Boolean(process.env.REDIS_URL);
const taskQueueName = "ytagent-video-analysis";
const generationQueueName = "ytagent-video-generation";
let analysisQueue = null;
let generationQueue = null;
let redisConnection = null;
const localGenerationJobs = new Map();
const uploadDir = path.join(__dirname, "uploads");
const studioProjectRoot = path.join(uploadDir, "studio-projects");
const studioProjectExpiryTimers = new Map();
const generationJobsFile = path.join(uploadDir, "generation-jobs.json");

function persistGenerationJobs() {
  if (generationQueue) return;
  const snapshot = Array.from(localGenerationJobs.entries()).map(([id, job]) => [id, job]);
  const temporaryFile = generationJobsFile + ".tmp";
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(snapshot));
    fs.renameSync(temporaryFile, generationJobsFile);
  } catch (error) {
    console.warn("Could not persist generation job state:", error.message);
    try { fs.unlinkSync(temporaryFile); } catch (_) {}
  }
}

function scheduleGenerationJobCleanup(id, delayMs = 24 * 60 * 60 * 1000) {
  const timer = setTimeout(() => {
    localGenerationJobs.delete(id);
    persistGenerationJobs();
  }, Math.max(1, delayMs));
  timer.unref();
}

function restoreGenerationJobs() {
  if (generationQueue || !fs.existsSync(generationJobsFile)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(generationJobsFile, "utf8"));
    if (!Array.isArray(saved)) return;
    const now = Date.now();
    for (const entry of saved) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, job] = entry;
      if (!/^[a-f0-9]{24}$/.test(id) || !job || typeof job !== "object") continue;

      if (job.state === "active" || job.state === "waiting") {
        job.state = "failed";
        job.error = "The server restarted before this film finished. Please submit the generation again.";
        job.completedAt = now;
      }

      if (job.state === "completed") {
        const filename = path.basename(job.result?.downloadUrl || "");
        const filePath = path.join(uploadDir, filename);
        if (!/^generated-[a-f0-9]{24}\.mp4$/.test(filename) || !fs.existsSync(filePath)) {
          job.state = "failed";
          job.error = "The server restarted and the temporary MP4 is no longer available. Please generate the film again.";
          job.completedAt = now;
        } else {
          const remainingMs = GENERATED_FILE_TTL_MS - (now - fs.statSync(filePath).mtimeMs);
          if (remainingMs <= 0) {
            try { fs.unlinkSync(filePath); } catch (_) {}
            job.state = "failed";
            job.error = "This temporary MP4 has expired. Please generate the film again.";
            job.completedAt = now;
          }
        }
      }

      const terminalAt = Number(job.completedAt || job.createdAt || now);
      const cleanupIn = 24 * 60 * 60 * 1000 - (now - terminalAt);
      if ((job.state === "completed" || job.state === "failed") && cleanupIn <= 0) continue;
      localGenerationJobs.set(id, job);
      if (job.state === "completed" || job.state === "failed") scheduleGenerationJobCleanup(id, cleanupIn);
    }
    persistGenerationJobs();
  } catch (error) {
    console.warn("Could not restore generation jobs:", error.message);
  }
}
const GENERATED_FILE_TTL_MS = 6 * 60 * 60 * 1000;
fs.mkdirSync(uploadDir, { recursive: true });
const objectStorage = createObjectStorage();
const r2StudioProjectsUploaded = new Set();

if (redisEnabled) {
  redisConnection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  redisConnection.on("error", error => console.error("Redis connection error:", error.message));
  redisConnection.on("ready", () => console.log("YTAgent Redis connection ready."));
}

function scheduleGeneratedFileExpiry(filePath, delayMs = GENERATED_FILE_TTL_MS) {
  const timer = setTimeout(() => {
    fs.promises.unlink(filePath).catch(() => {});
  }, Math.max(1, delayMs));
  timer.unref();
}

function scheduleStudioProjectExpiry(projectId, delayMs = GENERATED_FILE_TTL_MS) {
  if (!/^[a-f0-9]{24}$/i.test(String(projectId || ""))) return;
  const id = String(projectId).toLowerCase();
  const previous = studioProjectExpiryTimers.get(id);
  if (previous) clearTimeout(previous);
  const projectDir = path.join(studioProjectRoot, id);
  const timer = setTimeout(() => {
    studioProjectExpiryTimers.delete(id);
    fs.promises.rm(projectDir, { recursive: true, force: true }).catch(() => {});
  }, Math.max(1, delayMs));
  timer.unref();
  studioProjectExpiryTimers.set(id, timer);
}

function restoreStudioProjectExpiries() {
  try {
    if (!fs.existsSync(studioProjectRoot)) return;
    for (const id of fs.readdirSync(studioProjectRoot)) {
      if (!/^[a-f0-9]{24}$/i.test(id)) continue;
      const manifest = path.join(studioProjectRoot, id, "project.json");
      if (!fs.existsSync(manifest)) {
        fs.promises.rm(path.join(studioProjectRoot, id), { recursive: true, force: true }).catch(() => {});
        continue;
      }
      const stat = fs.statSync(manifest);
      const remainingMs = GENERATED_FILE_TTL_MS - (Date.now() - stat.mtimeMs);
      if (remainingMs <= 0) {
        fs.promises.rm(path.join(studioProjectRoot, id), { recursive: true, force: true }).catch(() => {});
      } else {
        scheduleStudioProjectExpiry(id, remainingMs);
      }
    }
  } catch (error) {
    console.warn("Could not restore studio project expiry timers:", error.message);
  }
}

async function persistGenerationArtifacts(outputPath, details) {
  if (!objectStorage.configured) return details;
  const filename = path.basename(outputPath);
  const persisted = { ...details };
  let videoStored = false;
  let projectStored = false;
  try {
    await objectStorage.putFile("generated/" + filename, outputPath, "video/mp4");
    videoStored = true;
    if (details.studioProjectId) {
      const projectDir = path.join(studioProjectRoot, details.studioProjectId);
      if (fs.existsSync(projectDir)) {
        await objectStorage.uploadDirectory(projectDir, "studio-projects/" + details.studioProjectId);
        await objectStorage.putBuffer("studio-projects/" + details.studioProjectId + "/_complete", Buffer.from("ok"), "text/plain");
        r2StudioProjectsUploaded.add(details.studioProjectId);
        projectStored = true;
      }
    }
    persisted.storage = { provider: "cloudflare-r2", videoStored, projectStored };
  } catch (error) {
    console.warn("Could not persist generated artifacts to Cloudflare R2:", error.message);
    persisted.storageWarning = "The film is ready locally, but durable R2 storage did not complete.";
  }
  return persisted;
}

function restoreGeneratedFileExpiries() {
  try {
    for (const filename of fs.readdirSync(uploadDir)) {
      if (!/^generated-[a-f0-9]{24}\.mp4$/.test(filename)) continue;
      const filePath = path.join(uploadDir, filename);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const remainingMs = GENERATED_FILE_TTL_MS - (Date.now() - stat.mtimeMs);
      if (remainingMs <= 0) {
        fs.unlinkSync(filePath);
      } else {
        scheduleGeneratedFileExpiry(filePath, remainingMs);
      }
    }
  } catch (error) {
    console.warn("Could not restore generated video expiry timers:", error.message);
  }
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
const sessionSecret = process.env.SESSION_SECRET || require("crypto").randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn("SESSION_SECRET is not configured. Sessions will be invalidated whenever this process restarts.");
}
const sessionOptions = {
  name: "ytagent.sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 24 * 60 * 60 * 1000 }
};
if (redisConnection) {
  sessionOptions.store = new RedisStore({ client: redisConnection, prefix: "ytagent:sess:", ttl: 24 * 60 * 60 });
  console.log("YTAgent sessions will persist in Redis.");
}
app.use(session(sessionOptions));
app.use("/studio", (req, res, next) => {
  if (!req.session?.tokens) return res.redirect("/");
  next();
}, express.static(path.join(__dirname, "public", "studio")));
app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_"))
});
const videoUpload = multer({
  storage,
  limits: { fileSize: 256 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => file.mimetype.startsWith("video/")
    ? cb(null, true)
    : cb(new Error("Please select a video file."))
});

// Public AI endpoints use paid/quota-limited provider keys, so cap per-IP usage.
const generationRateLimit = createRateLimiter({
  limit: 2,
  windowMs: 60 * 60 * 1000,
  message: "You've reached the video-generation limit. Please try again in about an hour."
});
const analysisRateLimit = createRateLimiter({
  limit: 5,
  windowMs: 60 * 60 * 1000,
  message: "You've reached the video-analysis limit. Please try again in about an hour."
});

function createGoogleOAuthState() {
  const crypto = require("crypto");
  const issuedAt = Date.now().toString(36);
  const nonce = crypto.randomBytes(24).toString("hex");
  const payload = issuedAt + "." + nonce;
  const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return payload + "." + signature;
}
function verifyGoogleOAuthState(state) {
  try {
    const crypto = require("crypto");
    const parts = String(state || "").split(".");
    if (parts.length !== 3) return false;
    const [issuedAt, nonce, signature] = parts;
    if (!/^[a-z0-9]+$/i.test(issuedAt) || !/^[a-f0-9]{48}$/i.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const age = Date.now() - parseInt(issuedAt, 36);
    if (!Number.isFinite(age) || age < 0 || age > 10 * 60 * 1000) return false;
    const payload = issuedAt + "." + nonce;
    const expected = crypto.createHmac("sha256", sessionSecret).update(payload).digest();
    const received = Buffer.from(signature, "base64url");
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  } catch (_) {
    return false;
  }
}

function oauthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth is not configured. Add the three Google variables to your environment.");
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}
function requireAuth(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error: "Connect your YouTube account first." });
  next();
}

app.get("/api/studio/projects/:projectId", requireAuth, async (req, res) => {
  try {
    let project = await readStudioProject(studioProjectRoot, req.params.projectId);
    if (!project && objectStorage.configured) {
      const prefix = "studio-projects/" + String(req.params.projectId).toLowerCase();
      if (await objectStorage.exists(prefix + "/_complete")) {
        project = await objectStorage.getJson(prefix + "/project.json");
      }
    }
    if (!project) return res.status(404).json({ error: "This editable project could not be found." });
    res.set("Cache-Control", "private, no-store");
    res.json(project);
  } catch (error) {
    res.status(400).json({ error: error.message || "Could not read the studio project." });
  }
});

app.put("/api/studio/projects/:projectId", requireAuth, async (req, res) => {
  try {
    let project = await readStudioProject(studioProjectRoot, req.params.projectId);
    if (project) {
      project = await saveStudioProject(studioProjectRoot, req.params.projectId, req.body?.source);
      scheduleStudioProjectExpiry(project.id);
    } else if (objectStorage.configured) {
      const id = String(req.params.projectId || "").toLowerCase();
      const prefix = "studio-projects/" + id;
      if (!await objectStorage.exists(prefix + "/_complete")) {
        return res.status(404).json({ saved: false, error: "The durable scene assets for this project could not be found." });
      }
      project = await objectStorage.getJson(prefix + "/project.json");
      if (!project) return res.status(404).json({ saved: false, error: "This editable project could not be found." });
      project.source = validateStudioSource(req.body?.source, id);
      project.updatedAt = new Date().toISOString();
    } else {
      return res.status(404).json({ saved: false, error: "This editable project has expired or could not be found." });
    }

    let durable = false;
    let storageWarning = null;
    if (objectStorage.configured) {
      try {
        const id = project.id;
        const prefix = "studio-projects/" + id;
        const markerKey = prefix + "/_complete";
        if (!r2StudioProjectsUploaded.has(id)) {
          const alreadyUploaded = await objectStorage.exists(markerKey);
          if (alreadyUploaded) {
            r2StudioProjectsUploaded.add(id);
          } else {
            const projectDir = path.join(studioProjectRoot, id);
            if (fs.existsSync(projectDir)) {
              await objectStorage.uploadDirectory(projectDir, prefix);
              await objectStorage.putBuffer(markerKey, Buffer.from("ok"), "text/plain");
              r2StudioProjectsUploaded.add(id);
            } else {
              storageWarning = "The project manifest was saved, but its original scene assets are not available in durable storage.";
            }
          }
        }
        await objectStorage.putJson(prefix + "/project.json", project);
        durable = r2StudioProjectsUploaded.has(id);
      } catch (error) {
        storageWarning = "The edit was saved to temporary storage, but the durable copy could not be updated.";
        console.warn("Could not update the studio project in R2:", error.message);
      }
    }
    res.set("Cache-Control", "private, no-store");
    res.json({ saved: true, durable, storageWarning, id: project.id, updatedAt: project.updatedAt });
  } catch (error) {
    const message = String(error.message || error);
    const status = /not found|expired/i.test(message) ? 404 : 400;
    res.status(status).json({ saved: false, error: message.slice(0, 300) });
  }
});

app.get("/api/studio/projects/:projectId/assets/:filename", requireAuth, async (req, res) => {
  try {
    const assetPath = resolveStudioAsset(studioProjectRoot, req.params.projectId, req.params.filename);
    try {
      const stat = await fs.promises.stat(assetPath);
      if (stat.isFile()) {
        res.set("Cache-Control", "private, max-age=300");
        return res.sendFile(assetPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!objectStorage.configured) return res.status(404).send("Studio asset not found.");
    const stored = await objectStorage.getObject("studio-projects/" + String(req.params.projectId).toLowerCase() + "/" + req.params.filename);
    if (!stored?.Body) return res.status(404).send("Studio asset not found.");
    res.set("Cache-Control", "private, max-age=300");
    if (stored.ContentType) res.set("Content-Type", stored.ContentType);
    if (stored.ContentLength) res.set("Content-Length", String(stored.ContentLength));
    stored.Body.pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") return res.status(404).send("Studio asset not found.");
    res.status(400).send(error.message || "Invalid studio asset.");
  }
});

function extractJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI returned an invalid analysis format.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function extractVideoFrames(videoPath) {
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable on this server.");
  const frameDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-frames-"));
  try {
    await new Promise((resolve, reject) => {
      const outputPattern = path.join(frameDir, "frame-%02d.jpg");
      const args = [
        "-hide_banner", "-loglevel", "error", "-i", videoPath,
        "-vf", "fps=1/10,scale=768:768:force_original_aspect_ratio=decrease",
        "-frames:v", "8", "-q:v", "5", outputPattern
      ];
      const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
      let errorText = "";
      child.stderr.on("data", chunk => { errorText += chunk.toString(); });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve() : reject(new Error(errorText.slice(0, 500) || "FFmpeg frame extraction failed.")));
    });
    const names = (await fs.promises.readdir(frameDir)).filter(name => /^frame-\d+\.jpg$/.test(name)).sort();
    if (!names.length) throw new Error("No readable frames could be extracted from this video.");
    return await Promise.all(names.map(async (name, index) => ({
      timestamp_seconds: index * 10,
      base64: (await fs.promises.readFile(path.join(frameDir, name))).toString("base64")
    })));
  } finally {
    await fs.promises.rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function reviewWithOpenAI(frames, draft) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const prompt = "Independently inspect these sampled frames extracted from the actual video. They are still images, so do not claim to hear audio or infer motion between frames. Describe only visible, supported evidence, including on-screen text and scene subjects. Then create accurate YouTube metadata. Never invent facts, people, dialogue, locations, statistics, or events. Return JSON only with evidence_summary, title, description, tags, hashtags, keywords. Title max 100 characters, tags max 15, hashtags 3 to 5, keywords 5 to 12. Existing Gemini draft for reference only: " + JSON.stringify(draft);
  const content = [{ type: "input_text", text: prompt }];
  for (const frame of frames) {
    content.push({ type: "input_text", text: "Approximate video timestamp: " + frame.timestamp_seconds + " seconds." });
    content.push({ type: "input_image", image_url: "data:image/jpeg;base64," + frame.base64, detail: "low" });
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: "You are an independent visual video analyst and YouTube SEO editor. Inspect the supplied frame images yourself. Do not merely repeat the Gemini draft.",
      input: [{ role: "user", content }],
      text: { format: { type: "json_object" } },
      max_output_tokens: 1400
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error("OpenAI visual analysis failed: HTTP " + response.status);
  const data = await response.json();
  const output = data.output?.flatMap(item => item.content || []).find(item => item.type === "output_text")?.text;
  return output ? extractJson(output) : null;
}

async function reviewWithGroq(frames, draft) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";
  const selected = frames.length <= 3
    ? frames
    : [frames[0], frames[Math.floor((frames.length - 1) / 2)], frames[frames.length - 1]];
  const content = [{
    type: "text",
    text: "Independently inspect these sampled still frames extracted from the actual video. Do not claim to hear audio or infer motion between frames. Describe only visible evidence, including on-screen text and scene subjects. Then create accurate YouTube metadata. Never invent facts, people, dialogue, locations, statistics, or events. Return JSON only with evidence_summary, title, description, tags, hashtags, keywords. Title max 100 characters, tags max 15, hashtags 3 to 5, keywords 5 to 12. Existing Gemini draft for reference only: " + JSON.stringify(draft)
  }];
  for (const frame of selected) {
    content.push({ type: "text", text: "Approximate video timestamp: " + frame.timestamp_seconds + " seconds." });
    content.push({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + frame.base64 } });
  }
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 1400
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) { const details = await response.text(); throw new Error("Groq visual analysis failed: HTTP " + response.status + " " + details.slice(0, 240)); }
  const data = await response.json();
  const output = data.choices?.[0]?.message?.content;
  return output ? extractJson(output) : null;
}

async function reviewWithClaude(frames, draft) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
  const content = [{
    type: "text",
    text: "Independently inspect these sampled still frames extracted from the actual video. Do not claim to hear audio or infer motion between frames. Describe only visible evidence, including on-screen text and scene subjects. Then create accurate YouTube metadata. Never invent facts, people, dialogue, locations, statistics, or events. Return JSON only with evidence_summary, title, description, tags, hashtags, keywords. Title max 100 characters, tags max 15, hashtags 3 to 5, keywords 5 to 12. Existing Gemini draft for reference only: " + JSON.stringify(draft)
  }];
  for (const frame of frames) {
    content.push({ type: "text", text: "Approximate video timestamp: " + frame.timestamp_seconds + " seconds." });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.base64 } });
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1600,
      system: "You are an independent visual video analyst and YouTube metadata editor. Inspect the supplied frame images yourself. Do not merely repeat the Gemini draft.",
      messages: [{ role: "user", content }]
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error("Claude visual analysis failed: HTTP " + response.status);
  const data = await response.json();
  const output = data.content?.filter(item => item.type === "text").map(item => item.text).join("\n");
  return output ? extractJson(output) : null;
}

async function analyzeWithGemini(file) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("AI video analysis is not configured yet. Add GEMINI_API_KEY in Railway Variables.");
  const mimeType = file.mimetype || "video/mp4";
  const fileBuffer = await fs.promises.readFile(file.path);
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(fileBuffer.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file: { display_name: path.basename(file.originalname || "ytagent-video") } }),
    signal: AbortSignal.timeout(120000)
  });
  if (!start.ok) throw new Error("Gemini could not start the video upload. Check the API key and model access.");
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not return a resumable upload URL.");
  const uploaded = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Length": String(fileBuffer.length),
      "Content-Type": mimeType
    },
    body: fileBuffer,
    signal: AbortSignal.timeout(120000)
  });
  if (!uploaded.ok) throw new Error("Gemini could not receive this video file.");
  let geminiFile = (await uploaded.json()).file;
  if (!geminiFile || !geminiFile.name) throw new Error("Gemini returned an invalid file response.");

  try {
    for (let attempt = 0; attempt < 60 && geminiFile.state !== "ACTIVE"; attempt++) {
      if (geminiFile.state === "FAILED") throw new Error("Gemini could not process this video.");
      await new Promise(resolve => setTimeout(resolve, 2000));
      const stateResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/" + geminiFile.name, {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(30000)
      });
      if (!stateResponse.ok) throw new Error("Could not check the video analysis status.");
      geminiFile = await stateResponse.json();
    }
    if (geminiFile.state !== "ACTIVE") throw new Error("Video analysis timed out. Try a shorter video.");

    const prompt = `Act as a meticulous video analyst and YouTube growth strategist. Inspect the supplied video itself, including its visuals, scene changes, on-screen text, subject, pacing, and audible content. First establish what the video actually contains. Never invent people, events, facts, dialogue, locations, statistics, or promises. Then create highly relevant YouTube metadata that accurately matches the video and helps the right audience discover it. Return valid JSON only with this exact shape:
{
  "evidence_summary": "Concise factual summary of what is visibly and audibly present",
  "title": "Compelling, specific YouTube title, maximum 100 characters",
  "description": "Search-friendly, engaging description that accurately describes the video",
  "tags": ["up to 15 specific YouTube tags"],
  "hashtags": ["3 to 5 relevant hashtags including #"],
  "keywords": ["5 to 12 natural search phrases viewers may use to find this exact video"],
  "language": "main spoken language, or none if no clear speech",
  "category_id": "best-fit YouTube category ID as a string, or empty if uncertain"
}
Do not repeat the same phrase excessively. Do not put hashtags in tags. Keywords must be natural search queries, not random broad words. Keep the title truthful, specific, clickable, and under 100 characters. `;
    const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    const generationUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
    const generationBody = JSON.stringify({
      contents: [{ parts: [{ file_data: { mime_type: geminiFile.mimeType || mimeType, file_uri: geminiFile.uri } }, { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    });
    const maxRetries = 2;
    let generated;
    let generationError = "";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        generated = await fetch(generationUrl, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: generationBody,
          signal: AbortSignal.timeout(60000)
        });
        if (generated.ok) break;
        generationError = await generated.text();
        console.error("the reason for error is =", "HTTP " + generated.status + ": " + String(generationError).slice(0, 1000));
        const temporaryFailure = [408, 429, 500, 502, 503, 504].includes(generated.status)
          || /high demand|overloaded|temporar(?:y|ily) unavailable|resource exhausted/i.test(generationError);
        if (!temporaryFailure || attempt === maxRetries) break;
      } catch (error) {
        generationError = error.message || "Network error while contacting Gemini.";
        console.error("the reason for error is =", generationError);
        if (attempt === maxRetries) break;
      }
      const delayMs = Math.min(8000, 1000 * (2 ** attempt));
      console.warn("Gemini generation attempt " + (attempt + 1) + " failed. Retrying in " + delayMs + "ms.");
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    if (!generated || !generated.ok) {
      console.error("Gemini generation failed after " + maxRetries + " retries. Final reason:", String(generationError).slice(0, 1000));
      throw new Error("Gemini could not analyse this video. Final reason: " + String(generationError).slice(0, 300));
    }
    const payload = await generated.json();
    const raw = payload.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
    if (!raw) throw new Error("Gemini returned no analysis. Try another video.");
    const parsed = extractJson(raw);
    let result = {
      evidence_summary: String(parsed.evidence_summary || ""),
      title: String(parsed.title || "").slice(0, 100),
      description: String(parsed.description || "").slice(0, 5000),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 15) : [],
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String).slice(0, 5) : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String).slice(0, 12) : [],
      language: String(parsed.language || "unknown"),
      category_id: String(parsed.category_id || "")
    };
    const providers = ["Google Gemini (full video)"];
    const reviewers = [];
    const reviewTasks = [];
    if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GROQ_API_KEY) {
      let frames = [];
      try {
        frames = await extractVideoFrames(file.path);
      } catch (frameError) {
        console.warn("Optional visual frame extraction failed:", frameError.message);
      }
      if (frames.length && process.env.OPENAI_API_KEY) {
        reviewTasks.push(reviewWithOpenAI(frames, result).then(value => ({ name: "OpenAI (video frames)", value })));
      }
      if (frames.length && process.env.ANTHROPIC_API_KEY) {
        reviewTasks.push(reviewWithClaude(frames, result).then(value => ({ name: "Claude (video frames)", value })));
      }
      if (frames.length && process.env.GROQ_API_KEY) {
        reviewTasks.push(reviewWithGroq(frames, result).then(value => ({ name: "Groq Qwen (video frames)", value })));
      }
      result.visual_frames_analysed = frames.length;
    }
    const reviews = await Promise.allSettled(reviewTasks);
    for (const review of reviews) {
      if (review.status !== "fulfilled" || !review.value.value) {
        if (review.status === "rejected") console.warn("Optional AI review skipped:", review.reason?.message || "Unknown error");
        continue;
      }
      reviewers.push(review.value);
      providers.push(review.value.name);
    }
    if (reviewers.length) {
      const candidates = reviewers.map(item => item.value);
      const choose = key => {
        const values = candidates.map(item => item[key]).filter(value => Array.isArray(value) ? value.length : typeof value === "string" && value.trim());
        return values.length ? values[0] : result[key];
      };
      result.ai_visual_evidence = reviewers.map(item => ({
        provider: item.name,
        summary: String(item.value.evidence_summary || "")
      })).filter(item => item.summary);
      result = {
        ...result,
        title: String(choose("title") || result.title).slice(0, 100),
        description: String(choose("description") || result.description).slice(0, 5000),
        tags: Array.isArray(choose("tags")) ? choose("tags").map(String).slice(0, 15) : result.tags,
        hashtags: Array.isArray(choose("hashtags")) ? choose("hashtags").map(String).slice(0, 5) : result.hashtags,
        keywords: Array.isArray(choose("keywords")) ? choose("keywords").map(String).slice(0, 12) : result.keywords
      };
    }
    result.ai_providers = providers;
    return result;
  } finally {
    fetch("https://generativelanguage.googleapis.com/v1beta/" + geminiFile.name, {
      method: "DELETE", headers: { "x-goog-api-key": apiKey }
    }).catch(() => {});
  }
}


async function analyzeWithGroqFallback(file, geminiError) {
  if (!process.env.GROQ_API_KEY) throw geminiError;
  let frames;
  try {
    frames = await extractVideoFrames(file.path);
    if (!frames.length) throw new Error("No usable video frames were extracted.");
  } catch (frameError) {
    throw new Error("Gemini analysis failed, and Groq fallback could not read the video: " + frameError.message);
  }
  const emptyDraft = { evidence_summary: "", title: "", description: "", tags: [], hashtags: [], keywords: [] };
  try {
    const parsed = await reviewWithGroq(frames, emptyDraft);
    if (!parsed) throw new Error("Groq returned no analysis.");
    return {
      evidence_summary: String(parsed.evidence_summary || ""),
      title: String(parsed.title || "").slice(0, 100),
      description: String(parsed.description || "").slice(0, 5000),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 15) : [],
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String).slice(0, 5) : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String).slice(0, 12) : [],
      language: String(parsed.language || "unknown"),
      category_id: String(parsed.category_id || ""),
      visual_frames_analysed: frames.length,
      ai_providers: ["Groq Qwen (video frames, Gemini fallback)"]
    };
  } catch (groqError) {
    console.error("Groq fallback failed:", groqError.message);
    throw new Error("Gemini analysis failed. Groq fallback also failed: " + groqError.message);
  }
}

async function analyzeVideo(file) {
  try {
    return await analyzeWithGemini(file);
  } catch (geminiError) {
    console.warn("Gemini analysis failed. Trying Groq fallback:", geminiError.message);
    return await analyzeWithGroqFallback(file, geminiError);
  }
}

app.get("/auth/google", (req, res) => {
  try {
    const client = oauthClient();
    // Signed, short-lived state avoids relying on a session cookie surviving
    // Google's cross-site redirect or a Railway process restart.
    const state = createGoogleOAuthState();
    const authUrl = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
      state
    });
    res.redirect(authUrl);
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!verifyGoogleOAuthState(req.query.state)) return res.status(400).send("OAuth state check failed or expired. Please restart the YouTube connection.");
    if (!req.query.code) return res.status(400).send("Google did not return an authorization code. Please try connecting again.");
    const { tokens } = await oauthClient().getToken(String(req.query.code));
    req.session.tokens = tokens;
    req.session.save(saveError => {
      if (saveError) {
        console.error("Could not save YouTube session:", saveError.message);
        return res.status(500).send("YouTube authorized successfully, but YTAgent could not save the connection. Please try again.");
      }
      res.redirect("/");
    });
  } catch (err) {
    console.error("OAuth callback failed:", err.message);
    res.status(500).send("YouTube connection failed. Check your OAuth settings and try again.");
  }
});


function socialState(req, provider) {
  const state = require("crypto").randomBytes(24).toString("hex");
  req.session.socialOAuthState = { provider, state };
  return state;
}
function verifySocialState(req, provider) {
  const saved = req.session.socialOAuthState;
  delete req.session.socialOAuthState;
  return Boolean(saved && saved.provider === provider && req.query.state === saved.state);
}

app.get("/auth/meta", (req, res) => {
  const { META_APP_ID, META_REDIRECT_URI } = process.env;
  if (!META_APP_ID || !META_REDIRECT_URI) return res.status(503).send("Meta connection is not configured yet. Add META_APP_ID and META_REDIRECT_URI in Railway Variables.");
  const state = socialState(req, "meta");
  const url = new URL("https://www.facebook.com/v22.0/dialog/oauth");
  url.search = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: META_REDIRECT_URI,
    state,
    response_type: "code",
    scope: "pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish"
  }).toString();
  req.session.save(error => error ? res.status(500).send("Could not start Meta connection.") : res.redirect(url.toString()));
});

app.get("/auth/meta/callback", async (req, res) => {
  if (!verifySocialState(req, "meta")) return res.status(400).send("Meta connection state check failed. Please try again.");
  try {
    const { META_APP_ID, META_APP_SECRET, META_REDIRECT_URI } = process.env;
    const tokenUrl = new URL("https://graph.facebook.com/v22.0/oauth/access_token");
    tokenUrl.search = new URLSearchParams({ client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: META_REDIRECT_URI, code: String(req.query.code || "") }).toString();
    const tokenResponse = await fetch(tokenUrl);
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error(tokenData.error?.message || "Meta token exchange failed.");
    const pagesResponse = await fetch("https://graph.facebook.com/v22.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=" + encodeURIComponent(tokenData.access_token));
    const pagesData = await pagesResponse.json();
    if (!pagesResponse.ok) throw new Error(pagesData.error?.message || "Could not retrieve your Facebook Pages.");
    req.session.socialAccounts = req.session.socialAccounts || {};
    req.session.socialAccounts.facebook = { connected: true, pages: (pagesData.data || []).map(p => ({ id: p.id, name: p.name, access_token: p.access_token })) };
    const instagram = (pagesData.data || []).find(p => p.instagram_business_account);
    if (instagram) req.session.socialAccounts.instagram = { connected: true, username: instagram.instagram_business_account.username || instagram.instagram_business_account.id, accountId: instagram.instagram_business_account.id, pageId: instagram.id, access_token: instagram.access_token };
    req.session.save(error => error ? res.status(500).send("Could not save Meta connection.") : res.redirect("/?social_connected=meta"));
  } catch (error) {
    console.error("Meta OAuth callback failed:", error.message);
    res.status(500).send("Meta connection failed: " + error.message);
  }
});

app.get("/auth/tiktok", (req, res) => {
  const { TIKTOK_CLIENT_KEY, TIKTOK_REDIRECT_URI } = process.env;
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_REDIRECT_URI) return res.status(503).send("TikTok connection is not configured yet. Add TIKTOK_CLIENT_KEY and TIKTOK_REDIRECT_URI in Railway Variables.");
  const state = socialState(req, "tiktok");
  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.search = new URLSearchParams({ client_key: TIKTOK_CLIENT_KEY, response_type: "code", scope: "user.info.basic,video.publish", redirect_uri: TIKTOK_REDIRECT_URI, state }).toString();
  req.session.save(error => error ? res.status(500).send("Could not start TikTok connection.") : res.redirect(url.toString()));
});

app.get("/auth/tiktok/callback", async (req, res) => {
  if (!verifySocialState(req, "tiktok")) return res.status(400).send("TikTok connection state check failed. Please try again.");
  try {
    const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, code: String(req.query.code || ""), grant_type: "authorization_code", redirect_uri: process.env.TIKTOK_REDIRECT_URI })
    });
    const tokenData = await response.json();
    if (!response.ok || !tokenData.access_token) throw new Error(tokenData.error_description || tokenData.message || "TikTok token exchange failed.");
    const profileResponse = await fetch("https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", { headers: { Authorization: "Bearer " + tokenData.access_token } });
    const profileData = await profileResponse.json();
    if (!profileResponse.ok) throw new Error(profileData.error?.message || "Could not retrieve TikTok profile.");
    req.session.socialAccounts = req.session.socialAccounts || {};
    req.session.socialAccounts.tiktok = { connected: true, username: profileData.data?.user?.username || profileData.data?.user?.display_name || "TikTok account", openId: tokenData.open_id, access_token: tokenData.access_token, refresh_token: tokenData.refresh_token };
    req.session.save(error => error ? res.status(500).send("Could not save TikTok connection.") : res.redirect("/?social_connected=tiktok"));
  } catch (error) {
    console.error("TikTok OAuth callback failed:", error.message);
    res.status(500).send("TikTok connection failed: " + error.message);
  }
});

app.get("/api/social-status", (req, res) => {
  const accounts = req.session.socialAccounts || {};
  res.json({
    instagram: accounts.instagram ? { connected: true, username: accounts.instagram.username || "Instagram connected" } : { connected: false },
    facebook: accounts.facebook ? { connected: true, pages: (accounts.facebook.pages || []).map(page => page.name) } : { connected: false },
    tiktok: accounts.tiktok ? { connected: true, username: accounts.tiktok.username || "TikTok connected" } : { connected: false }
  });
});

app.get("/api/status", async (req, res) => {
  if (!req.session.tokens) return res.json({ connected: false });
  try {
    const auth = oauthClient();
    auth.setCredentials(req.session.tokens);
    auth.on("tokens", tokens => { req.session.tokens = { ...req.session.tokens, ...tokens }; });
    const yt = google.youtube({ version: "v3", auth });
    const response = await yt.channels.list({ part: ["snippet"], mine: true });
    const channel = response.data.items && response.data.items[0];
    res.json({ connected: true, channel: channel ? channel.snippet.title : "YouTube channel connected" });
  } catch (err) {
    console.error("Status check failed:", err.message);
    res.json({ connected: false, error: "Your connection may have expired. Reconnect your account." });
  }
});

app.post("/api/analyze", analysisRateLimit, videoUpload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a video first." });
  if (analysisQueue) {
    try {
      const job = await analysisQueue.add("analyse-video", {
        path: req.file.path,
        mimetype: req.file.mimetype,
        originalname: req.file.originalname
      }, {
        attempts: 3,
        backoff: { type: "exponential", delay: 1500 },
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: { age: 86400, count: 5000 }
      });
      return res.status(202).json({ success: true, queued: true, jobId: String(job.id) });
    } catch (err) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      console.error("Could not queue video analysis:", err.message);
      return res.status(503).json({ error: "The task queue is temporarily unavailable. Please try again." });
    }
  }
  try {
    const analysis = await analyzeVideo(req.file);
    res.json({ success: true, analysis });
  } catch (err) {
    console.error("Video analysis failed:", err.message);
    res.status(502).json({ error: err.message || "Video analysis failed." });
  } finally {
    await fs.promises.unlink(req.file.path).catch(() => {});
  }
});

app.get("/api/analyze/:jobId", async (req, res) => {
  if (!analysisQueue) return res.status(404).json({ error: "Background task queue is not enabled." });
  try {
    const job = await analysisQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Analysis task not found. Please submit the video again." });
    const state = await job.getState();
    if (state === "completed") return res.json({ state, analysis: job.returnvalue });
    if (state === "failed") return res.json({ state, error: job.failedReason || "Video analysis failed." });
    return res.json({ state, progress: job.progress || 0 });
  } catch (err) {
    console.error("Task status check failed:", err.message);
    res.status(503).json({ error: "Could not check task progress. Please retry." });
  }
});

app.post("/api/upload", requireAuth, videoUpload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a video first." });
  const cleanup = () => fs.promises.unlink(req.file.path).catch(() => {});
  try {
    const title = String(req.body.title || "").trim();
    if (!title) { await cleanup(); return res.status(400).json({ error: "A video title is required." }); }
    const auth = oauthClient();
    auth.setCredentials(req.session.tokens);
    auth.on("tokens", tokens => { req.session.tokens = { ...req.session.tokens, ...tokens }; });
    const yt = google.youtube({ version: "v3", auth });
    const rawTags = String(req.body.tags || "").split(",").map(t => t.trim()).filter(Boolean);
    const keywords = String(req.body.keywords || "").split(",").map(t => t.trim()).filter(Boolean);
    const hashtags = String(req.body.hashtags || "").trim();
    const description = [String(req.body.description || "").trim(), keywords.length ? "Search topics: " + keywords.join(", ") : "", hashtags].filter(Boolean).join("\n\n").slice(0, 5000);
    const tags = [];
    let tagLength = 0;
    for (const tag of [...rawTags, ...keywords]) {
      const normalized = tag.slice(0, 100);
      const addedLength = normalized.length + (tags.length ? 1 : 0);
      if (tags.length >= 30 || tagLength + addedLength > 500) continue;
      if (!tags.some(existing => existing.toLowerCase() === normalized.toLowerCase())) {
        tags.push(normalized);
        tagLength += addedLength;
      }
    }
    const privacy = ["private", "unlisted", "public"].includes(req.body.privacy) ? req.body.privacy : "public";
    const response = await yt.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title: title.slice(0, 100), description, tags },
        status: { privacyStatus: privacy }
      },
      media: { body: fs.createReadStream(req.file.path) }
    });
    await cleanup();
    res.json({ success: true, videoId: response.data.id, url: "https://www.youtube.com/watch?v=" + response.data.id });
  } catch (err) {
    await cleanup();
    console.error("Upload failed:", err.message);
    res.status(500).json({ error: err.message.includes("quota") ? "YouTube API quota reached. Try again after quota resets." : "Upload failed. Check your Google API setup and try again." });
  }
});


function requireGpuWorker(req, res, next) {
  const expected = String(process.env.YT_AGENT_WORKER_TOKEN || "");
  const supplied = String(req.headers.authorization || "");
  const expectedHeader = "Bearer " + expected;
  if (!expected || Buffer.byteLength(supplied) !== Buffer.byteLength(expectedHeader) ||
      !require("crypto").timingSafeEqual(Buffer.from(supplied), Buffer.from(expectedHeader))) {
    return res.status(401).json({ error: "Invalid GPU worker credentials." });
  }
  next();
}

// The GPU notebook polls this app over outbound HTTPS. No temporary tunnel is needed.
app.get("/api/worker/next", requireGpuWorker, (_req, res) => {
  noteGpuWorkerPoll();
  const job = claimNextGpuJob();
  if (!job) return res.status(204).end();
  res.json(job);
});

app.get("/api/worker/status", requireAuth, (_req, res) => {
  res.json(getGpuWorkerStatus());
});

app.post("/api/worker/jobs/:jobId/progress", requireGpuWorker, (req, res) => {
  if (!/^[a-f0-9]{32}$/i.test(req.params.jobId)) return res.status(400).json({ error: "Invalid GPU job ID." });
  const accepted = updateGpuJobProgress(req.params.jobId, req.body?.progress, req.body?.message);
  res.json({ accepted });
});

app.post("/api/worker/jobs/:jobId/scenes/:index", requireGpuWorker,
  express.raw({ type: ["application/octet-stream", "video/mp4"], limit: "100mb" }),
  async (req, res) => {
    if (!/^[a-f0-9]{32}$/i.test(req.params.jobId)) return res.status(400).json({ error: "Invalid GPU job ID." });
    const index = Number(req.params.index);
    try {
      const result = await receiveGpuScene(req.params.jobId, index, req.body);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message || "Could not receive GPU scene." });
    }
  }
);

app.post("/api/worker/jobs/:jobId/audio/:index", requireGpuWorker,
  express.raw({ type: ["application/octet-stream", "audio/wav", "audio/x-wav"], limit: "20mb" }),
  async (req, res) => {
    if (!/^[a-f0-9]{32}$/i.test(req.params.jobId)) return res.status(400).json({ error: "Invalid GPU job ID." });
    const index = Number(req.params.index);
    try {
      const result = await receiveGpuAudio(req.params.jobId, index, req.body);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message || "Could not receive narration audio." });
    }
  }
);

app.post("/api/worker/jobs/:jobId/fail", requireGpuWorker, (req, res) => {
  if (!/^[a-f0-9]{32}$/i.test(req.params.jobId)) return res.status(400).json({ error: "Invalid GPU job ID." });
  const accepted = failGpuJob(req.params.jobId, req.body?.error || "The GPU worker failed.");
  res.json({ accepted });
});

const { generateEducationalVideo } = require("./video-generator");

app.post("/api/generate", generationRateLimit, async (req, res) => {
  const topic = String(req.body?.topic || "").trim();
  if (topic.length < 8) return res.status(400).json({ error: "Enter a video topic with at least 8 characters." });
  if (topic.length > 180) return res.status(400).json({ error: "Keep the topic under 180 characters." });
  if (generationQueue) {
    try {
      const counts = await generationQueue.getJobCounts("waiting", "active", "delayed");
      if (counts.waiting + counts.active + counts.delayed > 0) {
        return res.status(409).json({ error: "YTAgent is already generating a film. Wait for it to finish before starting another." });
      }
    } catch (error) {
      console.error("Could not check the video queue:", error.message);
      return res.status(503).json({ error: "The video task queue is temporarily unavailable." });
    }
  } else if (Array.from(localGenerationJobs.values()).some(job => job.state === "waiting" || job.state === "active")) {
    return res.status(409).json({ error: "YTAgent is already generating a film. Wait for it to finish before starting another." });
  }

  const id = require("crypto").randomBytes(12).toString("hex");
  const filename = "generated-" + id + ".mp4";
  const outputPath = path.join(uploadDir, filename);

  if (generationQueue) {
    try {
      const job = await generationQueue.add("generate-film", { topic, outputPath, filename }, {
        attempts: 1,
        removeOnComplete: { age: 86400, count: 200 },
        removeOnFail: { age: 86400, count: 200 }
      });
      if (process.env.KAGGLE_API_TOKEN) {
        kaggleWorkerSessionManager.ensure().then(result => {
          if (result.started) console.log("YTAgent launched the Kaggle batch GPU worker:", result.notebookRef, result.machineShape);
        }).catch(error => console.warn("Kaggle GPU worker auto-start failed:", error.message));
      }
      return res.status(202).json({ success: true, queued: true, jobId: String(job.id) });
    } catch (error) {
      console.error("Could not queue AI video generation:", error.message);
      return res.status(503).json({ error: "The video task queue is unavailable. Please try again later." });
    }
  }

  const job = { state: "waiting", progress: 0, message: "Waiting for the AI director.", createdAt: Date.now(), result: null, error: null };
  localGenerationJobs.set(id, job);
  persistGenerationJobs();
  setImmediate(async () => {
    job.state = "active";
    job.progress = 2;
    job.message = "AI director is planning the film.";
    persistGenerationJobs();
    try {
      const details = await generateEducationalVideo(topic, outputPath, (progress, message) => {
        job.progress = Math.max(job.progress || 0, Math.min(99, Number(progress) || 0));
        if (message) job.message = String(message).slice(0, 180);
        persistGenerationJobs();
      }, {
        studioProjectRoot,
        onGpuJobQueued: async ({ jobId: gpuJobId } = {}) => {
          if (!process.env.KAGGLE_API_TOKEN) {
            throw new Error("KAGGLE_API_TOKEN is missing. Configure Kaggle access before starting the free GPU worker.");
          }
          const result = await kaggleWorkerSessionManager.ensure();
          if (result.started) {
            console.log("YTAgent launched the Kaggle GPU batch for queued job:", gpuJobId, result.notebookRef);
          }
          return result;
        }
      });
      const durableDetails = await persistGenerationArtifacts(outputPath, details);
      job.result = { ...durableDetails, downloadUrl: "/api/generated/" + filename };
      job.progress = 100;
      job.message = "Your finished film is ready.";
      job.state = "completed";
      job.completedAt = Date.now();
      scheduleGeneratedFileExpiry(outputPath);
      if (details.studioProjectId) scheduleStudioProjectExpiry(details.studioProjectId);
      persistGenerationJobs();
      scheduleGenerationJobCleanup(id);
    } catch (error) {
      await fs.promises.unlink(outputPath).catch(() => {});
      job.error = error.message || "Video generation failed.";
      job.message = job.error;
      job.state = "failed";
      job.completedAt = Date.now();
      persistGenerationJobs();
      scheduleGenerationJobCleanup(id);
      console.error("AI video generation failed:", job.error);
    }
  });
  return res.status(202).json({ success: true, queued: true, jobId: id });
});

app.get("/api/generate/:jobId", async (req, res) => {
  if (generationQueue) {
    try {
      const job = await generationQueue.getJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: "Video generation task not found." });
      const state = await job.getState();
      if (state === "completed") {
        if (!job.data?.outputPath || !fs.existsSync(job.data.outputPath)) {
          return res.json({ state: "failed", error: "This temporary MP4 has expired or is no longer available. Please generate the film again." });
        }
        return res.json({ state, ...job.returnvalue });
      }
      if (state === "failed") return res.json({ state, error: job.failedReason || "Video generation failed." });
      return res.json({ state, progress: typeof job.progress === "number" ? job.progress : 0, message: job.data?.message || "YTAgent is processing your film." });
    } catch (error) {
      console.error("Video generation status check failed:", error.message);
      return res.status(503).json({ error: "Could not check video generation progress." });
    }
  }
  const job = localGenerationJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Video generation task not found. It may have expired after a server restart." });
  if (job.state === "completed") {
    const filename = path.basename(job.result?.downloadUrl || "");
    const filePath = path.join(uploadDir, filename);
    if (!/^generated-[a-f0-9]{24}\.mp4$/.test(filename) || !fs.existsSync(filePath)) {
      job.state = "failed";
      job.error = "This temporary MP4 has expired or is no longer available. Please generate the film again.";
      job.completedAt = Date.now();
      persistGenerationJobs();
      return res.json({ state: "failed", error: job.error });
    }
    return res.json({ state: job.state, ...job.result });
  }
  if (job.state === "failed") return res.json({ state: job.state, error: job.error });
  return res.json({ state: job.state, progress: Number(job.progress) || 0, message: job.message || "YTAgent is processing your film." });
});

app.get("/api/generated/:filename", async (req, res) => {
  const filename = String(req.params.filename || "");
  if (!/^generated-[a-f0-9]{24}\.mp4$/.test(filename)) return res.status(404).send("Video not found.");
  const filePath = path.join(uploadDir, filename);
  if (fs.existsSync(filePath)) {
    return res.download(filePath, "YTAgent-video.mp4", error => {
      if (!error) {
        fs.promises.unlink(filePath).catch(unlinkError => console.warn("Downloaded video cleanup failed:", unlinkError.message));
      } else if (!res.headersSent) {
        res.status(500).send("The video download failed. Please try again before the temporary file expires.");
      }
    });
  }
  if (!objectStorage.configured) return res.status(404).send("This generated video has expired or is no longer available.");
  try {
    const stored = await objectStorage.getObject("generated/" + filename);
    if (!stored?.Body) return res.status(404).send("This generated video could not be found.");
    res.set("Content-Type", stored.ContentType || "video/mp4");
    if (stored.ContentLength) res.set("Content-Length", String(stored.ContentLength));
    res.set("Content-Disposition", 'attachment; filename="YTAgent-video.mp4"');
    stored.Body.on("error", error => {
      console.error("R2 video stream failed:", error.message);
      if (!res.headersSent) res.status(502).end("The stored video could not be streamed.");
      else res.destroy(error);
    });
    stored.Body.pipe(res);
  } catch (error) {
    console.error("R2 video download failed:", error.message);
    if (!res.headersSent) res.status(502).send("The stored video could not be downloaded.");
  }
});


app.get("/api/kaggle/session-status", async (_req, res) => {
  try {
    const identity = kaggleNotebookIdentity();
    const [sessionResult, infoResult, outputResult, quotaResult] = await Promise.allSettled([
      callKaggleTool("get_notebook_session_status", { userName: identity.userName, kernelSlug: identity.kernelSlug }),
      callKaggleTool("get_notebook_info", { userName: identity.userName, kernelSlug: identity.kernelSlug }),
      callKaggleTool("list_notebook_session_output", { userName: identity.userName, kernelSlug: identity.kernelSlug, pageSize: 100, hasPageSize: true }),
      getKaggleQuota()
    ]);
    const session = sessionResult.status === "fulfilled" ? kaggleToolData(sessionResult.value) : null;
    const info = infoResult.status === "fulfilled" ? kaggleToolData(infoResult.value) : null;
    const output = outputResult.status === "fulfilled" ? kaggleToolData(outputResult.value) : null;
    const quota = quotaResult.status === "fulfilled" ? quotaResult.value : null;
    res.status(session || info || output ? 200 : 502).json({
      notebookRef: identity.slug,
      session,
      quota,
      outputLog: typeof output?.log === "string" ? output.log.slice(-12000) : null,
      outputFiles: Array.isArray(output?.files) ? output.files.map(file => ({ fileName: file.fileName || file.file_name, size: file.size || null })) : [],
      notebook: info?.metadata ? {
        machineShape: info.metadata.machineShape || info.metadata.machine_shape || null,
        enableGpu: info.metadata.enableGpu ?? info.metadata.enable_gpu ?? null,
        enableInternet: info.metadata.enableInternet ?? info.metadata.enable_internet ?? null,
        sessionTimeoutSeconds: info.metadata.sessionTimeoutSeconds || info.metadata.session_timeout_seconds || null,
        currentVersionNumber: info.metadata.currentVersionNumber || info.metadata.current_version_number || null
      } : null,
      errors: {
        session: sessionResult.status === "rejected" ? String(sessionResult.reason?.message || sessionResult.reason) : null,
        notebook: infoResult.status === "rejected" ? String(infoResult.reason?.message || infoResult.reason) : null
      }
    });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error).slice(0, 400) });
  }
});

app.get("/api/kaggle/cli-status", async (_req, res) => {
  try {
    const identity = kaggleNotebookIdentity();
    const result = await getKaggleKernelStatus(identity);
    res.set("Cache-Control", "no-store");
    res.json({ notebookRef: identity.slug, ...result });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error).slice(0, 500) });
  }
});

app.get("/api/kaggle/cli-status/:version", async (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isSafeInteger(version) || version < 1) return res.status(400).json({ error: "A valid notebook version is required." });
  try {
    const identity = kaggleNotebookIdentity();
    const result = await getKaggleKernelStatus({ ...identity, slug: identity.slug + "/" + version });
    res.set("Cache-Control", "no-store");
    res.json({ notebookRef: identity.slug, version, ...result });
  } catch (error) {
    res.status(502).json({ error: String(error.message || error).slice(0, 500) });
  }
});

app.get("/api/kaggle/status", async (_req, res) => {
  if (!process.env.KAGGLE_API_TOKEN) {
    return res.status(503).json({ connected: false, error: "Kaggle API token is not configured." });
  }
  try {
    const tools = await listKaggleTools();
    const notebookTools = tools.filter(tool => /kernel|notebook/i.test(tool.name + " " + tool.description));
    res.json({
      connected: true,
      provider: "Kaggle MCP",
      notebookRef: process.env.KAGGLE_NOTEBOOK_REF || null,
      toolCount: tools.length,
      notebookTools
    });
  } catch (error) {
    console.error("Kaggle connection check failed:", error.message);
    res.status(502).json({ connected: false, error: error.message });
  }
});




function kaggleNotebookIdentity() {
  const ref = String(process.env.KAGGLE_NOTEBOOK_REF || "samsonbamigboye/notebook477419e21e").trim();
  const parts = ref.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("KAGGLE_NOTEBOOK_REF must use username/notebook-slug format.");
  return { userName: parts[0], kernelSlug: parts[1], slug: ref };
}

function kaggleToolData(result) {
  if (result?.structuredContent) return result.structuredContent;
  const textContent = (result?.content || []).find(item => item.type === "text")?.text;
  if (textContent) {
    try { return JSON.parse(textContent); } catch (_) { return { message: textContent }; }
  }
  return result;
}

const workerBootstrapTokens = new Map();

function issueWorkerBootstrapToken() {
  const now = Date.now();
  for (const [token, expiresAt] of workerBootstrapTokens) {
    if (expiresAt <= now) workerBootstrapTokens.delete(token);
  }
  const token = require("crypto").randomBytes(32).toString("hex");
  workerBootstrapTokens.set(token, now + 10 * 60 * 1000);
  return token;
}

async function getCanonicalKaggleNotebookSource(identity) {
  const branch = String(process.env.GITHUB_BRANCH || "main").replace(/[^a-zA-Z0-9._-]/g, "");
  const url = "https://raw.githubusercontent.com/qingremzy/YTAgent/" + branch + "/gpu-worker/YTAgent_Free_GPU_Worker.ipynb";
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new Error("Could not fetch the canonical YTAgent Kaggle notebook from GitHub (HTTP " + response.status + ").");
  }
  const source = await response.text();
  validateNotebookSource(source);
  return source;
}

const kaggleWorkerSessionManager = createKaggleWorkerSessionManager({
  callKaggleTool,
  getGpuWorkerStatus,
  getNotebookIdentity: kaggleNotebookIdentity,
  getNotebookSource: getCanonicalKaggleNotebookSource,
  getBootstrapToken: () => issueWorkerBootstrapToken(),
  pushNotebookWithCli: pushNotebookWithKaggleCli,
  kaggleToolData
});

app.post("/api/worker/bootstrap", (req, res) => {
  const authorization = String(req.get("authorization") || "");
  const match = authorization.match(/^Bearer ([a-f0-9]{64})$/i);
  if (!match) return res.status(401).json({ error: "Worker bootstrap token is invalid or expired." });
  const expiresAt = workerBootstrapTokens.get(match[1]);
  if (!expiresAt || expiresAt <= Date.now()) {
    workerBootstrapTokens.delete(match[1]);
    return res.status(401).json({ error: "Worker bootstrap token is invalid or expired." });
  }
  const workerToken = process.env.YT_AGENT_WORKER_TOKEN;
  if (!workerToken) return res.status(503).json({ error: "YTAgent worker authentication is not configured." });
  workerBootstrapTokens.delete(match[1]);
  res.set("Cache-Control", "no-store");
  return res.json({ token: workerToken });
});

app.get("/api/kaggle/notebook", requireAuth, async (_req, res) => {
  const identity = kaggleNotebookIdentity();
  const [infoResult, statusResult] = await Promise.allSettled([
    callKaggleTool("get_notebook_info", { userName: identity.userName, kernelSlug: identity.kernelSlug }),
    callKaggleTool("get_notebook_session_status", { userName: identity.userName, kernelSlug: identity.kernelSlug })
  ]);
  const info = infoResult.status === "fulfilled" ? kaggleToolData(infoResult.value) : null;
  const session = statusResult.status === "fulfilled" ? kaggleToolData(statusResult.value) : null;
  const errors = {};
  if (!info) errors.notebook = infoResult.reason?.message || "Notebook metadata is unavailable.";
  if (!session) errors.session = statusResult.reason?.message || "Session status is unavailable.";
  // A missing committed notebook version and an active interactive session can coexist.
  // Return both observations instead of hiding all usable information behind HTTP 502.
  res.status(info || session ? 200 : 502).json({
    connected: Boolean(info || session),
    notebookRef: identity.slug,
    notebook: info,
    session,
    errors
  });
});


app.get("/api/kaggle/notebook/source", requireAuth, async (_req, res) => {
  try {
    const identity = kaggleNotebookIdentity();
    const info = kaggleToolData(await callKaggleTool("get_notebook_info", {
      userName: identity.userName, kernelSlug: identity.kernelSlug
    }));
    const source = info?.blob?.source || info?.kernel?.blob?.source || "";
    if (!source) return res.status(404).json({ error: "Kaggle did not return a saved notebook source. Open the notebook in Kaggle and save a version first." });
    res.json({
      notebookRef: identity.slug,
      source,
      versionNumber: info?.metadata?.currentVersionNumber || info?.metadata?.current_version_number || null,
      title: info?.metadata?.title || null
    });
  } catch (error) {
    console.error("Kaggle notebook source fetch failed:", error.message);
    res.status(502).json({ error: error.message || "Could not retrieve notebook source." });
  }
});

app.post("/api/kaggle/notebook/save", requireAuth, async (req, res) => {
  try {
    const identity = kaggleNotebookIdentity();
    const source = validateNotebookSource(req.body?.source);
    const info = kaggleToolData(await callKaggleTool("get_notebook_info", {
      userName: identity.userName, kernelSlug: identity.kernelSlug
    }));
    const metadata = info?.metadata || {};
    const request = buildNotebookSaveRequest(identity.slug, source, metadata);
    const result = kaggleToolData(await callKaggleTool("save_notebook", request));
    if (result?.error) return res.status(502).json({ saved: false, error: String(result.error).slice(0, 500) });
    res.json({
      saved: true,
      executed: true,
      notebookRef: identity.slug,
      versionNumber: result?.versionNumber || result?.version_number || null,
      url: result?.url || ("https://www.kaggle.com/code/" + identity.slug),
      message: "Kaggle saved a new notebook version and started its top-to-bottom execution."
    });
  } catch (error) {
    const message = String(error.message || error);
    console.error("Kaggle notebook save failed:", message);
    const status = /notebook source|JSON|cells|secret|too large|must be/i.test(message) ? 400 : 502;
    res.status(status).json({ saved: false, error: message.slice(0, 500) });
  }
});

app.post("/api/kaggle/notebook/start", requireAuth, async (_req, res) => {
  try {
    const result = await kaggleWorkerSessionManager.ensure();
    res.json(result);
  } catch (error) {
    const message = String(error.message || error);
    console.error("Kaggle notebook start failed:", message);
    res.status(502).json({ started: false, error: message.slice(0, 500) });
  }
});


app.post("/api/kaggle/notebook/cancel", requireAuth, async (req, res) => {
  const kernelSessionId = Number(req.body?.kernelSessionId);
  if (!Number.isSafeInteger(kernelSessionId) || kernelSessionId <= 0) {
    return res.status(400).json({ cancelled: false, error: "A valid kernelSessionId is required." });
  }
  try {
    const result = await callKaggleTool("cancel_notebook_session", { kernelSessionId });
    res.json({ cancelled: true, result: kaggleToolData(result) });
  } catch (error) {
    console.error("Kaggle notebook cancel failed:", error.message);
    res.status(502).json({ cancelled: false, error: error.message });
  }
});

app.post("/auth/logout", (req, res) => req.session.destroy(() => res.json({ success: true })));
app.get("/health", (_req, res) => res.json({
  ok: true,
  app: "YTAgent",
  storage: {
    mode: objectStorage.configured ? "cloudflare-r2" : "temporary",
    durable: objectStorage.configured,
    r2Configured: objectStorage.configured,
    localExpiryHours: 6
  },
  jobs: {
    redisQueueEnabled: redisEnabled,
    durableQueueConfigured: Boolean(redisConnection && redisConnection.status === "ready"),
    redisConfigured: redisEnabled,
    redisConnected: Boolean(redisConnection && redisConnection.status === "ready"),
    sessionStore: redisConnection ? "redis" : "memory"
  },
  durabilityReady: Boolean(redisConnection && redisConnection.status === "ready" && objectStorage.configured)
}));

app.get("/api/diagnostics", async (req, res) => {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  add("Backend API", "passed", "Express server is responding.");
  add("Video engine", "passed", "Video generation module loaded.");
  const storyConfigured = Boolean(process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || process.env.AGENT_API_KEY);
  add("AI story provider", storyConfigured ? "configured" : "warning",
    storyConfigured ? "At least one story-provider key is configured. This checks configuration, not a billable generation." : "No story-provider key was detected.");
  add("Gemini video analysis", process.env.GEMINI_API_KEY ? "configured" : "warning",
    process.env.GEMINI_API_KEY ? "Gemini API key is present; live inference was not triggered." : "GEMINI_API_KEY is missing.");
  const zeroCost = process.env.YTAGENT_ZERO_COST_MODE === "true" || process.env.GEMINI_FREE_TIER_ONLY === "true";
  add("Free-tier mode", zeroCost ? "configured" : "info", "Zero-cost mode: " + (zeroCost ? "enabled" : "not explicitly enabled") + ".");
  add("Redis queue", redisConnection && redisConnection.status === "ready" ? "passed" : "warning",
    redisConnection && redisConnection.status === "ready" ? "Redis is connected; background jobs use durable queues." : "Redis is not connected; jobs use process-local storage and can be lost on restart.");
  add("Cloud storage", objectStorage.configured ? "passed" : "warning",
    objectStorage.configured ? "Cloudflare R2 is configured." : "R2 is not configured; generated MP4s and studio projects expire after six hours.");
  add("Kaggle credentials", process.env.KAGGLE_API_TOKEN ? "configured" : "warning",
    process.env.KAGGLE_API_TOKEN ? "Kaggle API token is present." : "KAGGLE_API_TOKEN is missing.");
  if (process.env.KAGGLE_API_TOKEN) {
    try {
      const kaggleTools = await Promise.race([
        listKaggleTools(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Kaggle check timed out after 10 seconds.")), 10000))
      ]);
      add("Kaggle MCP", "passed", "Kaggle responded with " + kaggleTools.length + " available tools.");
    } catch (error) {
      add("Kaggle MCP", "failed", String(error.message || error).slice(0, 240));
    }
  } else {
    add("Kaggle MCP", "blocked", "Skipped because Kaggle credentials are not configured.");
  }
  const agnesQuotaConfirmation = String(process.env.AGNES_FREE_QUOTA_CONFIRMED || "").trim().toLowerCase();
  const agnesFreeReady = Boolean(process.env.AGNES_API_KEY &&
    ["true", "1", "yes", "confirmed", "on"].includes(agnesQuotaConfirmation) &&
    (process.env.AGNES_VIDEO_MODEL || "agnes-video-2.5-flash") === "agnes-video-2.5-flash");
  add("Agnes free video route", agnesFreeReady ? "configured" : "warning",
    agnesFreeReady
      ? "Agnes Video 2.5 Flash is enabled under the explicitly confirmed free-quota setting."
      : "Agnes key: " + (process.env.AGNES_API_KEY ? "present" : "missing") +
        "; free-quota confirmation: " + (["true", "1", "yes", "confirmed", "on"].includes(agnesQuotaConfirmation) ? "confirmed" : "not confirmed") +
        "; model: " + (process.env.AGNES_VIDEO_MODEL || "agnes-video-2.5-flash") + ". Confirm free quota or start the Kaggle GPU worker.");
  add("GPU worker", "info", JSON.stringify(getGpuWorkerStatus()).slice(0, 500));
  if (req.session && req.session.tokens) {
    try {
      const auth = oauthClient();
      auth.setCredentials(req.session.tokens);
      const yt = google.youtube({ version: "v3", auth });
      const response = await yt.channels.list({ part: ["snippet"], mine: true });
      const channel = response.data.items && response.data.items[0];
      add("YouTube OAuth", "passed", "Connected to " + ((channel && channel.snippet && channel.snippet.title) || "a YouTube channel") + ".");
    } catch (_) {
      add("YouTube OAuth", "failed", "The saved YouTube session could not be verified. Reconnect before publishing.");
    }
  } else {
    add("YouTube OAuth", "not_connected", "No YouTube account is connected in this browser session. Publishing is unavailable until connected.");
  }
  const failed = checks.filter(item => item.status === "failed").length;
  const warnings = checks.filter(item => ["warning", "blocked", "not_connected"].includes(item.status)).length;
  res.set("Cache-Control", "no-store");
  res.json({
    ok: failed === 0,
    summary: failed ? failed + " failed check(s), " + warnings + " warning(s)." : warnings ? "Core service is online with " + warnings + " configuration warning(s)." : "All configured checks passed.",
    checkedAt: new Date().toISOString(),
    checks
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Video is too large. Maximum size is 256 MB." });
  res.status(400).json({ error: err.message || "Something went wrong." });
});
if (redisEnabled) {
  analysisQueue = new Queue(taskQueueName, { connection: redisConnection });
  const configuredConcurrency = Number(process.env.ANALYSIS_CONCURRENCY || 4);
  const concurrency = Number.isInteger(configuredConcurrency) ? Math.min(50, Math.max(1, configuredConcurrency)) : 4;
  const worker = new Worker(taskQueueName, async job => {
    try {
      const analysis = await analyzeVideo(job.data);
      await job.updateProgress(100);
      return analysis;
    } finally {
      await fs.promises.unlink(job.data.path).catch(() => {});
    }
  }, { connection: redisConnection, concurrency, drainDelay: 30 });
  worker.on("failed", (job, error) => console.error("Analysis task failed:", job?.id, error.message));
  worker.on("error", error => console.error("Analysis worker error:", error.message));

  generationQueue = new Queue(generationQueueName, { connection: redisConnection });
  const generationWorker = new Worker(generationQueueName, async job => {
    try {
      await job.updateProgress(5);
      const details = await generateEducationalVideo(job.data.topic, job.data.outputPath, async (progress, message) => {
        await job.updateProgress(Math.max(0, Math.min(99, Number(progress) || 0)));
        await job.updateData({ ...job.data, message: String(message || "").slice(0, 180) });
      }, { studioProjectRoot });
      const durableDetails = await persistGenerationArtifacts(job.data.outputPath, details);
      await job.updateProgress(100);
      scheduleGeneratedFileExpiry(job.data.outputPath);
      if (durableDetails.studioProjectId) scheduleStudioProjectExpiry(durableDetails.studioProjectId);
      return { ...durableDetails, downloadUrl: "/api/generated/" + job.data.filename };
    } catch (error) {
      await fs.promises.unlink(job.data.outputPath).catch(() => {});
      throw error;
    }
  }, { connection: redisConnection, concurrency: 1, drainDelay: 30 });
  generationWorker.on("failed", (job, error) => console.error("Video generation task failed:", job?.id, error.message));
  generationWorker.on("error", error => console.error("Video generation worker error:", error.message));
  console.log("YTAgent Redis queues enabled. Analysis concurrency:", concurrency, "Video generation concurrency: 1");
} else {
  console.warn("REDIS_URL is not set. Background jobs are process-local and will be lost on restart. Configure Redis for durable queues.");
}

restoreGenerationJobs();
restoreGeneratedFileExpiries();
restoreStudioProjectExpiries();
if (objectStorage.configured) {
  console.log("Cloudflare R2 artifact storage is enabled. Local working copies expire after six hours.");
} else {
  console.warn("R2 is not configured. Generated videos and studio projects use temporary local storage and expire after six hours.");
}
app.listen(PORT, () => console.log("YTAgent running on port " + PORT));
