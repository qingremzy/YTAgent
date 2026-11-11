const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isGroqTtsEnabled,
  shouldAttemptGroqTts,
  isRateLimitError,
  edgeTtsRetryDelayMs
} = require("../video-generator");

test("Groq TTS is skipped for the rest of a film after a 429", () => {
  const state = { groqRateLimited: true };
  assert.equal(shouldAttemptGroqTts(state, { GROQ_API_KEY: "configured", GROQ_TTS_ENABLED: "true" }), false);
});

test("Groq TTS still requires explicit opt-in when not rate-limited", () => {
  assert.equal(shouldAttemptGroqTts({}, { GROQ_API_KEY: "configured" }), false);
  assert.equal(shouldAttemptGroqTts({}, { GROQ_API_KEY: "configured", GROQ_TTS_ENABLED: "true" }), true);
});

test("429 and rate-limit messages are recognized for retry handling", () => {
  assert.equal(isRateLimitError(new Error("Unexpected server response: 429")), true);
  assert.equal(isRateLimitError(new Error("Too Many Requests")), true);
  assert.equal(isRateLimitError(new Error("Connection timed out")), false);
});

test("Edge TTS retry delays use bounded exponential backoff", () => {
  assert.equal(edgeTtsRetryDelayMs(0), 2000);
  assert.equal(edgeTtsRetryDelayMs(1), 4000);
  assert.equal(edgeTtsRetryDelayMs(2), 8000);
  assert.equal(edgeTtsRetryDelayMs(8), 8000);
});
