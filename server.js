require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 3000);
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

    const prompt = `Analyse the supplied video itself. Do not guess or invent events, identities, dialogue, facts, or context. Base every field only on visible and audible evidence. If something is uncertain, use cautious wording. Return valid JSON only with this exact shape:
{
  "title": "YouTube title, maximum 100 characters",
  "description": "Accurate, engaging YouTube description, no invented facts",
  "tags": ["up to 15 accurate YouTube tags, each short"],
  "hashtags": ["3 to 5 relevant hashtags including #"],
  "social_caption": "A separate engaging social-media caption that accurately describes this video",
  "language": "main spoken language, or 'none' if no clear speech",
  "subtitles_srt": "SRT subtitles with timestamps if intelligible speech exists, otherwise empty string"
}
For subtitles, transcribe only words that are actually audible. Use approximate timestamps in HH:MM:SS,mmm format and sequential SRT numbering. If speech cannot be understood, return an empty subtitles_srt. Do not put hashtags in tags. Keep the title truthful, specific and interesting. `;
    const configuredModel = process.env.GEMINI_MODEL;
    const model = !configuredModel || configuredModel === "gemini-2.5-flash"
      ? "gemini-3.8-flash"
      : configuredModel;
    const generationUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
    const generationBody = JSON.stringify({
      contents: [{ parts: [{ file_data: { mime_type: geminiFile.mimeType || mimeType, file_uri: geminiFile.uri } }, { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.35 }
    });
    const maxRetries = 30;
    const retryDelayMs = 1000;
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
      console.warn("Gemini generation attempt " + (attempt + 1) + " failed. Retrying in 1 second. Retry " + (attempt + 1) + " of " + maxRetries + ".");
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
    if (!generated || !generated.ok) {
      console.error("Gemini generation failed after " + maxRetries + " retries. Final reason:", String(generationError).slice(0, 1000));
      throw new Error("Gemini could not analyse this video after 30 retries. Final reason: " + String(generationError).slice(0, 300));
    }
    const payload = await generated.json();
    const raw = payload.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
    if (!raw) throw new Error("Gemini returned no analysis. Try another video.");
    const parsed = JSON.parse(raw);
    return {
      title: String(parsed.title || "").slice(0, 100),
      description: String(parsed.description || "").slice(0, 5000),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 15) : [],
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String).slice(0, 8) : [],
      social_caption: String(parsed.social_caption || ""),
      language: String(parsed.language || "unknown"),
      subtitles_srt: String(parsed.subtitles_srt || "")
    };
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

app.post("/api/analyze", requireAuth, videoUpload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a video first." });
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
    const tags = String(req.body.tags || "").split(",").map(t => t.trim()).filter(Boolean).slice(0, 30);
    const description = [String(req.body.description || "").trim(), String(req.body.hashtags || "").trim()].filter(Boolean).join("\n\n").slice(0, 5000);
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
app.listen(PORT, () => console.log("YTAgent running on port " + PORT));
