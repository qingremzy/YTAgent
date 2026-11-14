"use strict";
const assert = require("node:assert/strict");
const { validateDag, computeCriticalPath, runDag } = require("./forge-dag-scheduler");

(async () => {
  const dag = { a: ["c"], b: ["c"], c: [] };
  assert.equal(validateDag(dag), true);
  assert.deepEqual(computeCriticalPath(dag, { a: 2, b: 4, c: 3 }), { c: 3, a: 5, b: 7 });
  assert.throws(() => validateDag({ a: ["missing"] }), /unknown node/);
  assert.throws(() => validateDag({ a: ["b"], b: ["a"] }), /cycle/);

  const calls = [];
  const result = await runDag({
    dag: { intro: ["action"], action: ["ending"], independent: [] },
    maxWorkers: 2,
    generateFn: async id => {
      calls.push(id);
      if (id === "action") throw new Error("simulated provider outage");
      return id + ".mp4";
    }
  });
  assert.equal(result.state.intro, "succeeded");
  assert.equal(result.state.action, "failed");
  assert.equal(result.state.ending, "blocked");
  assert.equal(result.state.independent, "succeeded");
  assert.deepEqual(result.failed.sort(), ["action", "ending"]);
  assert.equal(calls.includes("ending"), false);
  console.log("Forge-inspired DAG scheduler tests passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
