const assert = require("node:assert/strict");
const { buildYumCutPrompt, findNumber, findString } = require("./yumcut");

const scenes = Array.from({ length: 10 }, (_, i) => ({
  narration: "A clear narration line for scene " + (i + 1),
  visual_direction: "A character performs a specific physical action in a cinematic environment, scene " + (i + 1)
}));
const prompt = buildYumCutPrompt(scenes, "A story about curiosity");
assert.ok(prompt.includes("moving film"));
assert.ok(prompt.includes("Scene 10:"));
assert.equal(findNumber({ quote: { tokenCost: 24 } }, ["tokencost"]), 24);
assert.equal(findNumber({ tokenBalance: 100 }, ["tokenbalance"]), 100);
assert.equal(findNumber({ message: "unknown" }, ["tokencost"]), null);
assert.equal(findString({ project: { projectId: "proj_123456" } }, ["projectid"]), "proj_123456");
console.log("YumCut fallback schema and safety tests passed.");
