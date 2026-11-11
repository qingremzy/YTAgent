const test = require("node:test");
const assert = require("node:assert/strict");
const { isGroqTtsEnabled } = require("../video-generator");

test("Groq TTS stays disabled when only a Groq API key exists", () => {
  assert.equal(isGroqTtsEnabled({ GROQ_API_KEY: "configured" }), false);
});

test("Groq TTS stays disabled unless the explicit enable flag is true", () => {
  assert.equal(isGroqTtsEnabled({ GROQ_API_KEY: "configured", GROQ_TTS_ENABLED: "false" }), false);
  assert.equal(isGroqTtsEnabled({ GROQ_TTS_ENABLED: "true" }), false);
});

test("Groq TTS requires both the API key and explicit opt-in", () => {
  assert.equal(isGroqTtsEnabled({ GROQ_API_KEY: "configured", GROQ_TTS_ENABLED: "true" }), true);
});
