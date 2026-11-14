const assert = require("node:assert/strict");
const { BEAT_GROUPS, buildSixBeatPrompts, isCapacityUnavailable } = require("./multi-provider-orchestrator");

const scenes = Array.from({ length: 10 }, (_, index) => ({
  visual_direction: "A camera follows a scientist carefully demonstrating experiment number " + (index + 1) + " inside a realistic research laboratory."
}));

const prompts = buildSixBeatPrompts(scenes, "How the human brain learns");
assert.equal(prompts.length, 6, "the director's ten shots must be grouped into six ten-second beats");
assert.deepEqual(BEAT_GROUPS, [[0,1],[2,3],[4,5],[6,7],[8],[9]]);
assert.ok(prompts.every(prompt => prompt.includes("exactly 10 seconds")));
assert.ok(prompts[0].includes(scenes[0].visual_direction));
assert.ok(prompts[0].includes(scenes[1].visual_direction));
assert.ok(prompts[5].includes(scenes[9].visual_direction));
assert.throws(() => buildSixBeatPrompts(scenes.slice(0, 9), "invalid"), /ten-scene/);
assert.equal(isCapacityUnavailable(new Error("LTX public ZeroGPU queue rejected the request")), true);
assert.equal(isCapacityUnavailable(new Error("Agnes video queue is full")), true);
assert.equal(isCapacityUnavailable(new Error("HTTP 503 service unavailable")), true);
assert.equal(isCapacityUnavailable(new Error("Invalid API key")), false);
console.log("Six-beat multi-provider orchestration tests passed.");

assert.equal(isCapacityUnavailable(new Error("Hugging Face ZeroGPU quota exceeded")), true);
