const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAudioTempo } = require("./renderer");

test("keeps narration at normal speed when it fits", () => {
  assert.equal(normalizeAudioTempo(undefined), "1.000");
  assert.equal(normalizeAudioTempo(1), "1.000");
});

test("accepts a modest speed adjustment to fit a scene", () => {
  assert.equal(normalizeAudioTempo(1.2), "1.200");
  assert.equal(normalizeAudioTempo(1.35), "1.350");
});

test("rejects excessive speed changes that would damage narration", () => {
  assert.throws(() => normalizeAudioTempo(1.36), /Shorten the spoken line/);
  assert.throws(() => normalizeAudioTempo(0.9), /Shorten the spoken line/);
  assert.throws(() => normalizeAudioTempo(NaN), /Shorten the spoken line/);
});
