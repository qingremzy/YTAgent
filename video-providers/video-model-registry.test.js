"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {VIDEO_MODEL_POOL,getFreeHostedModelCandidates,getSelfHostedModels} = require("./video-model-registry");

test("the research pool contains thirty distinct video models", () => {
  assert.equal(VIDEO_MODEL_POOL.length,30);
  assert.equal(new Set(VIDEO_MODEL_POOL.map(item=>item.id)).size,30);
  assert.ok(VIDEO_MODEL_POOL.every(item=>item.model && item.task && item.access));
});
test("free hosted candidates never mislabel self-hosted weights as free APIs", () => {
  assert.ok(getFreeHostedModelCandidates().every(item=>item.access!=="self_hosted"));
  assert.equal(getFreeHostedModelCandidates({allowConditionalQuota:false}).some(item=>item.id==="agnes-video-2.5-flash"),false);
});
test("self-hosted pool is separate from public endpoints", () => {
  assert.equal(getSelfHostedModels().length,29);
  assert.ok(getSelfHostedModels().every(item=>item.freeHosted===false));
});
