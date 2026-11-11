const assert = require("node:assert/strict");
const { parseMediaInfo } = require("./quality-check");
const info = parseMediaInfo([
  "Duration: 00:01:00.04, start: 0.000000, bitrate: 1000 kb/s",
  "Stream #0:0: Video: h264, yuv420p, 540x960",
  "Stream #0:1: Audio: aac, 48000 Hz, stereo"
].join("\n"));
assert.equal(info.duration_seconds, 60.04);
assert.equal(info.has_video, true);
assert.equal(info.has_audio, true);
const missingAudio = parseMediaInfo("Duration: 00:01:00.00\nStream #0:0: Video: h264");
assert.equal(missingAudio.has_audio, false);
const missingDuration = parseMediaInfo("Stream #0:0: Video: h264\nStream #0:1: Audio: aac");
assert.equal(missingDuration.duration_seconds, null);
console.log("Video quality-check tests passed.");
