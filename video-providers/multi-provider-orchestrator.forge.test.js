"use strict";
const assert = require("node:assert/strict");
const { buildBeatDag, BEAT_GROUPS } = require("./multi-provider-orchestrator");

const scenes = Array.from({ length: 10 }, (_, index) => ({
  id: "scene-" + (index + 1),
  visual_direction: "A character moves through the scene."
}));
const sequential = buildBeatDag(scenes);
assert.equal(BEAT_GROUPS.length, 6);
assert.deepEqual(sequential["beat-0"], ["beat-1"]);
assert.deepEqual(sequential["beat-4"], ["beat-5"]);
assert.deepEqual(sequential["beat-5"], []);

const dependent = scenes.map(scene => ({ ...scene, dependencies: [] }));
dependent[4].dependencies = ["scene-1"];
dependent[8].dependencies = ["scene-5"];
const graph = buildBeatDag(dependent);
assert.deepEqual(graph["beat-0"], ["beat-2"]);
assert.deepEqual(graph["beat-2"], ["beat-4"]);
console.log("Forge CPM beat-planning integration tests passed.");
