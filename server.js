require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");
const { Queue, Worker } = require("bullmq");
const IORedis = require("ioredis");

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 3000);
const redisEnabled = Boolean(process.env.REDIS_URL);
const taskQueueName = "ytagent-video-analysis";
let analysisQueue = null;
let redisConnection = null;
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(session({
  name: "ytagent.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 24 * 60 * 60 * 1000 }
}));
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

function extractJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\\s*/i, "").replace(/\\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI returned an invalid analysis format.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function reviewWithOpenAI(evidence, draft) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: "You are an expert YouTube SEO editor. You did not see the video. Use only the supplied video-analysis evidence. Do not add events, facts, names, claims, or dialogue not supported by that evidence. Improve the draft for accuracy, search relevance, and viewer appeal. Return JSON only with title, description, tags, hashtags, keywords. Title max 100 characters. Tags max 15. Hashtags 3 to 5. Keywords 5 to 12.",
      input: JSON.stringify({ video_evidence: evidence, draft_metadata: draft }),
      text: { format: { type: "json_object" } },
      max_output_tokens: 1200
    })
  });
  if (!response.ok) throw new Error("OpenAI review failed: HTTP " + response.status);
  const data = await response.json();
  const output = data.output?.flatMap(item => item.content || []).find(item => item.type === "output_text")?.text;
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
    body: JSON.stringify({ file: { display_name: path.basename(file.originalname || "ytagent-video") } })
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
    body: fileBuffer
  });
  if (!uploaded.ok) throw new Error("Gemini could not receive this video file.");
  let geminiFile = (await uploaded.json()).file;
  if (!geminiFile || !geminiFile.name) throw new Error("Gemini returned an invalid file response.");

  try {
    for (let attempt = 0; attempt < 60 && geminiFile.state !== "ACTIVE"; attempt++) {
      if (geminiFile.state === "FAILED") throw new Error("Gemini could not process this video.");
      await new Promise(resolve => setTimeout(resolve, 2000));
      const stateResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/" + geminiFile.name, {
        headers: { "x-goog-api-key": apiKey }
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
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const generationUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
    const generationBody = JSON.stringify({
      contents: [{ parts: [{ file_data: { mime_type: geminiFile.mimeType || mimeType, file_uri: geminiFile.uri } }, { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.35 }
    });
    const maxRetries = 5;
    let generated;
    let generationError = "";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        generated = await fetch(generationUrl, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: generationBody
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
    const providers = ["Google Gemini"];
    if (process.env.OPENAI_API_KEY) {
      try {
        const reviewed = await reviewWithOpenAI(result.evidence_summary, result);
        if (reviewed) {
          result = {
            ...result,
            title: String(reviewed.title || result.title).slice(0, 100),
            description: String(reviewed.description || result.description).slice(0, 5000),
            tags: Array.isArray(reviewed.tags) && reviewed.tags.length ? reviewed.tags.map(String).slice(0, 15) : result.tags,
            hashtags: Array.isArray(reviewed.hashtags) && reviewed.hashtags.length ? reviewed.hashtags.map(String).slice(0, 5) : result.hashtags,
            keywords: Array.isArray(reviewed.keywords) && reviewed.keywords.length ? reviewed.keywords.map(String).slice(0, 12) : result.keywords
          };
          providers.push("OpenAI");
        }
      } catch (reviewError) {
        console.warn("OpenAI second-opinion skipped:", reviewError.message);
      }
    }
    result.ai_providers = providers;
    return result;
  } finally {
    fetch("https://generativelanguage.googleapis.com/v1beta/" + geminiFile.name, {
      method: "DELETE", headers: { "x-goog-api-key": apiKey }
    }).catch(() => {});
  }
}

app.get("/auth/google", (req, res) => {
  try {
    const client = oauthClient();
    const state = require("crypto").randomBytes(24).toString("hex");
    req.session.oauthState = state;
    const authUrl = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
      state
    });
    req.session.save(saveError => {
      if (saveError) return res.status(500).send("Could not start YouTube connection. Please try again.");
      res.redirect(authUrl);
    });
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send("OAuth state check failed. Please try connecting again.");
    delete req.session.oauthState;
    const { tokens } = await oauthClient().getToken(String(req.query.code || ""));
    req.session.tokens = tokens;
    res.redirect("/");
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

app.post("/api/analyze", videoUpload.single("video"), async (req, res) => {
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
    const analysis = await analyzeWithGemini(req.file);
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

app.post("/auth/logout", (req, res) => req.session.destroy(() => res.json({ success: true })));
app.get("/health", (_req, res) => res.json({ ok: true, app: "YTAgent" }));
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Video is too large. Maximum size is 256 MB." });
  res.status(400).json({ error: err.message || "Something went wrong." });
});
if (redisEnabled) {
  redisConnection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  analysisQueue = new Queue(taskQueueName, { connection: redisConnection });
  const configuredConcurrency = Number(process.env.ANALYSIS_CONCURRENCY || 4);
  const concurrency = Number.isInteger(configuredConcurrency) ? Math.min(50, Math.max(1, configuredConcurrency)) : 4;
  const worker = new Worker(taskQueueName, async job => {
    try {
      const analysis = await analyzeWithGemini(job.data);
      await job.updateProgress(100);
      return analysis;
    } finally {
      await fs.promises.unlink(job.data.path).catch(() => {});
    }
  }, { connection: redisConnection, concurrency });
  worker.on("failed", (job, error) => console.error("Analysis task failed:", job?.id, error.message));
  worker.on("error", error => console.error("Analysis worker error:", error.message));
  console.log("YTAgent task queue enabled. Worker concurrency:", concurrency);
} else {
  console.warn("REDIS_URL is not set. Analysis will run synchronously. Add Redis to enable queued parallel processing.");
}

app.listen(PORT, () => console.log("YTAgent running on port " + PORT));
