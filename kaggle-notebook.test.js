const test = require("node:test");
const assert = require("node:assert/strict");
const { validateNotebookSource, buildNotebookSaveRequest, patchNotebookForBatchRun } = require("./kaggle-notebook");

function notebook() {
  return JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { cell_type: "markdown", metadata: {}, source: ["# YTAgent"] },
    { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["print('ready')"] }
  ] });
}

test("validates a Jupyter notebook before saving", () => {
  assert.equal(validateNotebookSource(notebook()), notebook());
  assert.throws(() => validateNotebookSource("not json"), /valid JSON/);
  assert.throws(() => validateNotebookSource(JSON.stringify({ nbformat: 3, cells: [] })), /nbformat 4/);
  assert.throws(() => validateNotebookSource(JSON.stringify({ nbformat: 4, cells: [{ cell_type: "markdown", source: ["valid", null] }] })), /Source arrays must contain only text strings/);
});

test("rejects pasted Kaggle API tokens in notebook source", () => {
  const source = notebook().replace("print('ready')", "token = 'KGAT_abcdefghijklmnopqrstuvwxyz123456'");
  assert.throws(() => validateNotebookSource(source), /Kaggle API token/);
});

test("builds save request while preserving Kaggle notebook settings", () => {
  const request = buildNotebookSaveRequest("owner/worker", notebook(), {
    title: "Worker", language: "python", kernel_type: "notebook",
    is_private: true, enable_gpu: true, enable_internet: true,
    machine_shape: "NvidiaTeslaT4", dataset_data_sources: ["owner/data"]
  });
  assert.equal(request.slug, "owner/worker");
  assert.equal(request.text, notebook());
  assert.equal(request.machineShape, "NvidiaTeslaT4");
  assert.equal(request.enableInternet, true);
  assert.deepEqual(request.datasetDataSources, ["owner/data"]);
});


test("patches the notebook runner to execute the one-job worker in the Kaggle kernel", () => {
  const patched = JSON.parse(patchNotebookForBatchRun(notebook().replace("print('ready')", "print('--run-once')")));
  const runner = patched.cells.find(cell => cell.cell_type === "code");
  assert.match(runner.source.join(""), /runpy\.run_path/);
  assert.match(runner.source.join(""), /--wait-seconds/);
  assert.equal(validateNotebookSource(JSON.stringify(patched)), JSON.stringify(patched));
});
