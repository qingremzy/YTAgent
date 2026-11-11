const test = require("node:test");
const assert = require("node:assert/strict");
const { createKaggleWorkerSessionManager } = require("./kaggle-worker-session");

const identity = { userName: "samsonbamigboye", kernelSlug: "notebook477419e21e", slug: "samsonbamigboye/notebook477419e21e" };

function makeManager({ online = false, status = "COMPLETE", machineShape = "NvidiaTeslaT4", delay = 0 } = {}) {
  const calls = [];
  const manager = createKaggleWorkerSessionManager({
    getGpuWorkerStatus: () => ({ online }),
    getNotebookIdentity: () => identity,
    kaggleToolData: value => value,
    callKaggleTool: async (name, args) => {
      calls.push({ name, args });
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (name === "get_notebook_session_status") return { status };
      if (name === "get_notebook_info") return { metadata: { machineShape, language: "python", kernelType: "notebook", enableInternet: true } };
      if (name === "create_notebook_session") return { operationId: "operation-123" };
      throw new Error("Unexpected Kaggle tool " + name);
    }
  });
  return { manager, calls };
}

test("starts the saved GPU notebook when the worker is offline and no session is active", async () => {
  const { manager, calls } = makeManager();
  const result = await manager.ensure();
  assert.equal(result.started, true);
  assert.equal(result.machineShape, "NvidiaTeslaT4");
  assert.equal(result.notebookRef, identity.slug);
  assert.deepEqual(calls.map(call => call.name), ["get_notebook_session_status", "get_notebook_info", "create_notebook_session"]);
  assert.equal(calls[2].args.enableInternet, true);
});

test("does not create a duplicate session when Kaggle already reports RUNNING", async () => {
  const { manager, calls } = makeManager({ status: "RUNNING" });
  const result = await manager.ensure();
  assert.equal(result.started, false);
  assert.equal(result.alreadyRunning, true);
  assert.equal(calls.some(call => call.name === "create_notebook_session"), false);
});

test("does not call Kaggle when the worker heartbeat is already online", async () => {
  const { manager, calls } = makeManager({ online: true });
  const result = await manager.ensure();
  assert.equal(result.workerOnline, true);
  assert.equal(calls.length, 0);
});

test("deduplicates simultaneous notebook start requests", async () => {
  const { manager, calls } = makeManager({ delay: 15 });
  const [first, second] = await Promise.all([manager.ensure(), manager.ensure()]);
  assert.equal(first.started, true);
  assert.equal(second.started, true);
  assert.equal(calls.filter(call => call.name === "create_notebook_session").length, 1);
});

test("refuses to start a notebook without a configured GPU machine shape", async () => {
  const { manager } = makeManager({ machineShape: "" });
  await assert.rejects(manager.ensure(), /GPU machine shape/);
});
