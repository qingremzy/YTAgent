const test = require("node:test");
const assert = require("node:assert/strict");
const { createKaggleWorkerSessionManager } = require("./kaggle-worker-session");

const identity = { userName: "samsonbamigboye", kernelSlug: "notebook477419e21e", slug: "samsonbamigboye/notebook477419e21e" };

function notebookSource() {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { cell_type: "markdown", execution_count: null, metadata: {}, outputs: [], source: ["# YTAgent"] },
    { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["worker_token = os.environ.get('YT_AGENT_WORKER_TOKEN')"] },
    { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["print('--run-once')"] }
  ] });
}

function makeManager({ online = false, status = "COMPLETE", machineShape = "NvidiaTeslaT4", delay = 0, canonicalSource = null } = {}) {
  const calls = [];
  const manager = createKaggleWorkerSessionManager({
    getGpuWorkerStatus: () => ({ online }),
    getNotebookIdentity: () => identity,
    getNotebookSource: canonicalSource ? async () => canonicalSource : undefined,
    kaggleToolData: value => value,
    callKaggleTool: async (name, args) => {
      calls.push({ name, args });
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (name === "get_notebook_info") return { metadata: { machineShape, language: "python", kernelType: "notebook", enableInternet: true }, blob: { source: notebookSource() } };
      if (name === "save_notebook") return { versionNumber: 7 };
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
  assert.deepEqual(calls.map(call => call.name), ["get_notebook_info", "save_notebook"]);
  assert.equal(calls[1].args.enableInternet, true);
  assert.equal(calls[1].args.kernelExecutionType, "SaveAndRunAll");
  assert.match(calls[1].args.text, /runpy\.run_path/);
  assert.equal(result.versionNumber, 7);
});

test("does not create a duplicate run when the worker heartbeat is already online", async () => {
  const { manager, calls } = makeManager({ online: true });
  const result = await manager.ensure();
  assert.equal(result.started, false);
  assert.equal(result.alreadyRunning, true);
  assert.equal(calls.length, 0);
});

test("deduplicates simultaneous notebook start requests", async () => {
  const { manager, calls } = makeManager({ delay: 15 });
  const [first, second] = await Promise.all([manager.ensure(), manager.ensure()]);
  assert.equal(first.started, true);
  assert.equal(second.started, true);
  assert.equal(calls.filter(call => call.name === "save_notebook").length, 1);
});

test("does not submit a duplicate Kaggle run while the previous run may still be queued", async () => {\n  const { manager, calls } = makeManager();\n  const first = await manager.ensure();\n  const second = await manager.ensure();\n  assert.equal(first.started, true);\n  assert.equal(second.started, false);\n  assert.equal(second.alreadyRunning, true);\n  assert.ok(second.retryAfterMs > 0);\n  assert.equal(calls.filter(call => call.name === "save_notebook").length, 1);\n});\n\ntest("refuses to start a notebook without a configured GPU machine shape", async () => {
  const { manager } = makeManager({ machineShape: "" });
  await assert.rejects(manager.ensure(), /GPU machine shape/);
});

test("uses the canonical GitHub notebook instead of a stale Kaggle-saved copy", async () => {
  const canonical = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { cell_type: "markdown", metadata: {}, source: ["# Canonical YTAgent notebook"] },
    { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["print('--run-once')"] }
  ] });
  const { manager, calls } = makeManager({ canonicalSource: canonical });
  await manager.ensure();
  assert.match(calls[1].args.text, /Canonical YTAgent notebook/);
  assert.doesNotMatch(calls[1].args.text, /# YTAgent/);
});

test("uses the Kaggle CLI runner when available instead of the short MCP save call", async () => {
  const cliCalls = [];
  const toolCalls = [];
  const manager = createKaggleWorkerSessionManager({
    getGpuWorkerStatus: () => ({ online: false }),
    getNotebookIdentity: () => identity,
    kaggleToolData: value => value,
    getNotebookSource: async () => notebookSource(),
    pushNotebookWithCli: async args => {
      cliCalls.push(args);
      return { cli: true, versionNumber: 8, timeoutSeconds: 32400 };
    },
    callKaggleTool: async (name, args) => {
      toolCalls.push({ name, args });
      if (name === "get_notebook_info") return { metadata: { machineShape: "NvidiaTeslaT4", enableGpu: true, enableInternet: true } };
      throw new Error("Unexpected Kaggle tool " + name);
    }
  });
  const result = await manager.ensure();
  assert.equal(result.started, true);
  assert.equal(result.versionNumber, 8);
  assert.equal(cliCalls.length, 1);
  assert.equal(cliCalls[0].identity.slug, identity.slug);
  assert.match(cliCalls[0].source, /runpy\.run_path/);
  assert.equal(cliCalls[0].metadata.machineShape, "NvidiaTeslaT4");
  assert.deepEqual(toolCalls.map(call => call.name), ["get_notebook_info"]);
});

test("uses a one-time bootstrap token and sanitizes malformed markdown cells", async () => {
  const bootstrapToken = "a".repeat(64);
  let pushedSource = "";
  const manager = createKaggleWorkerSessionManager({
    getGpuWorkerStatus: () => ({ online: false }),
    getNotebookIdentity: () => identity,
    getNotebookSource: async () => notebookSource(),
    getBootstrapToken: async () => bootstrapToken,
    pushNotebookWithCli: async args => {
      pushedSource = args.source;
      return { cli: true, versionNumber: 9, timeoutSeconds: 32400 };
    },
    callKaggleTool: async name => {
      if (name === "get_notebook_info") return { metadata: { machineShape: "NvidiaTeslaT4", enableGpu: true, enableInternet: true } };
      throw new Error("Unexpected Kaggle tool " + name);
    }
  });
  await manager.ensure();
  const notebook = JSON.parse(pushedSource);
  assert.equal(notebook.cells[0].execution_count, undefined);
  assert.equal(notebook.cells[0].outputs, undefined);
  const tokenCell = notebook.cells.find(cell => cell.cell_type === "code" && (Array.isArray(cell.source) ? cell.source.join("") : cell.source).includes("/api/worker/bootstrap"));
  assert.ok(tokenCell);
  assert.match(tokenCell.source.join(""), new RegExp(bootstrapToken));
  assert.doesNotMatch(tokenCell.source.join(""), /get_secret/);
});
