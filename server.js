require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");

const app = express();
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
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) return cb(null, true);
    cb(new Error("Please select a video file."));
  }
});

function oauthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Google OAuth is not configured. Add the three Google variables to your .env file.");
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}
function requireAuth(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error: "Connect your YouTube account first." });
  next();
}

app.get("/auth/google", (req, res) => {
  try {
    const client = oauthClient();
    const state = require("crypto").randomBytes(24).toString("hex");
    req.session.oauthState = state;
    res.redirect(client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
      state
    }));
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send("OAuth state check failed. Please try connecting again.");
    delete req.session.oauthState;
    const client = oauthClient();
    const { tokens } = await client.getToken(String(req.query.code || ""));
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
    const response = await yt.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title: title.slice(0, 100), description: String(req.body.description || "").slice(0, 5000), tags },
        status: { privacyStatus: ["private", "unlisted", "public"].includes(req.body.privacy) ? req.body.privacy : "private" }
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

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/health", (_req, res) => res.json({ ok: true, app: "YTAgent" }));
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Video is too large. Maximum size in this starter app is 256 MB." });
  res.status(400).json({ error: err.message || "Something went wrong." });
});

app.listen(PORT, () => console.log("YTAgent running on port " + PORT));
