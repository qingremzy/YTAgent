"use strict";

const MAX_NOTEBOOK_BYTES = 750 * 1024;

function validateNotebookSource(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("Notebook source must be provided as JSON text.");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_NOTEBOOK_BYTES) {
    throw new Error("Notebook source is too large. Maximum size is 750 KB.");
  }
  if (/KGAT_[A-Za-z0-9_-]{20,}/.test(source)) {
    throw new Error("A Kaggle API token appears inside the notebook. Use Kaggle Secrets instead of hardcoding credentials.");
  }
  let notebook;
  try { notebook = JSON.parse(source); } catch (_) {
    throw new Error("Notebook source is not valid JSON.");
  }
  if (!notebook || notebook.nbformat !== 4 || !Array.isArray(notebook.cells) || notebook.cells.length === 0) {
    throw new Error("Expected a valid Jupyter notebook (nbformat 4) containing at least one cell.");
  }
  for (const [index, cell] of notebook.cells.entries()) {
    if (!cell || !["code", "markdown", "raw"].includes(cell.cell_type) || !(typeof cell.source === "string" || Array.isArray(cell.source)) || (Array.isArray(cell.source) && !cell.source.every(line => typeof line === "string"))) {
      throw new Error("Notebook cell " + (index + 1) + " has an invalid type or source. Source arrays must contain only text strings.");
    }
  }
  return source;
}

function buildNotebookSaveRequest(slug, source, metadata = {}) {
  const get = (camel, snake, fallback) => {
    if (metadata[camel] !== undefined && metadata[camel] !== null) return metadata[camel];
    if (metadata[snake] !== undefined && metadata[snake] !== null) return metadata[snake];
    return fallback;
  };
  const machineShape = get("machineShape", "machine_shape", "NvidiaTeslaT4");
  const notebookId = Number(get("id", "id", 0)) || null;
  const enableGpu = get("enableGpu", "enable_gpu", Boolean(machineShape));
  const enableInternet = get("enableInternet", "enable_internet", true);
  const isPrivate = get("isPrivate", "is_private", true);
  const language = get("language", "language", "python");
  const kernelType = get("kernelType", "kernel_type", "notebook");
  const newTitle = get("title", "title", "YTAgent Free GPU Worker");
  const sessionTimeoutSeconds = 32400;
  const kernelExecutionType = "SaveAndRunAll";
  return {
    id: notebookId,
    idNullable: notebookId,
    hasId: Boolean(notebookId),
    slug,
    slugNullable: slug,
    newTitle,
    newTitleNullable: newTitle,
    text: source,
    textNullable: source,
    language,
    languageNullable: language,
    kernelType,
    kernelTypeNullable: kernelType,
    isPrivate,
    isPrivateNullable: isPrivate,
    enableGpu,
    enableGpuNullable: enableGpu,
    enableInternet,
    enableInternetNullable: enableInternet,
    machineShape,
    machineShapeNullable: machineShape,
    datasetDataSources: get("datasetDataSources", "dataset_data_sources", []),
    datasetDataSourcesSetter: get("datasetDataSources", "dataset_data_sources", []),
    kernelDataSources: get("kernelDataSources", "kernel_data_sources", []),
    kernelDataSourcesSetter: get("kernelDataSources", "kernel_data_sources", []),
    competitionDataSources: get("competitionDataSources", "competition_data_sources", []),
    competitionDataSourcesSetter: get("competitionDataSources", "competition_data_sources", []),
    modelDataSources: get("modelDataSources", "model_data_sources", []),
    modelDataSourcesSetter: get("modelDataSources", "model_data_sources", []),
    categoryIds: get("categoryIds", "category_ids", []),
    categoryIdsSetter: get("categoryIds", "category_ids", []),
    kernelExecutionType,
    kernelExecutionTypeNullable: kernelExecutionType,
    hasKernelExecutionType: true,
    sessionTimeoutSeconds,
    sessionTimeoutSecondsNullable: sessionTimeoutSeconds,
    hasSessionTimeoutSeconds: true,
    hasEnableGpu: true,
    hasEnableInternet: true,
    hasMachineShape: true,
    hasIsPrivate: true,
    hasSlug: true,
    hasText: true,
    hasLanguage: true,
    hasKernelType: true,
    hasNewTitle: true
  };
}

function patchNotebookForBatchRun(source, options = {}) {
  validateNotebookSource(source);
  const notebook = JSON.parse(source);
  // Kaggle's nbconvert validator rejects code-only fields on markdown cells.
  // Normalize all cells before saving/running the notebook through the CLI.
  notebook.cells.forEach((item, index) => {
    if (!item.metadata || typeof item.metadata !== "object") item.metadata = {};
    if (!item.id) item.id = "ytagent-" + index.toString(36);
    if (item.cell_type === "markdown" || item.cell_type === "raw") {
      delete item.execution_count;
      delete item.outputs;
    } else if (item.cell_type === "code") {
      if (!Array.isArray(item.outputs)) item.outputs = [];
      if (item.execution_count === undefined) item.execution_count = null;
    }
  });

  const tokenCell = notebook.cells.find(item => {
    if (!item || item.cell_type !== "code") return false;
    const cellSource = Array.isArray(item.source) ? item.source.join("") : item.source;
    return typeof cellSource === "string" && cellSource.includes("YT_AGENT_WORKER_TOKEN");
  });
  if (options.bootstrapToken) {
    if (!/^[a-f0-9]{64}$/.test(options.bootstrapToken)) {
      throw new Error("Kaggle worker bootstrap token must be a 64-character hex value.");
    }
    if (!tokenCell) throw new Error("Kaggle worker notebook is missing its worker-token cell.");
    const serverUrl = String(options.serverUrl || "https://ytagent-production-1038.up.railway.app").replace(/\/$/, "");
    tokenCell.source = [
      "import os, torch, requests\n",
      "bootstrap_token = " + JSON.stringify(options.bootstrapToken) + "\n",
      "response = requests.post(" + JSON.stringify(serverUrl + "/api/worker/bootstrap") + ", headers={\"Authorization\": \"Bearer \" + bootstrap_token}, timeout=25)\n",
      "response.raise_for_status()\n",
      "worker_token = response.json().get(\"token\")\n",
      "if not worker_token: raise RuntimeError(\"YTAgent secure worker bootstrap returned no token.\")\n",
      "os.environ[\"YT_AGENT_WORKER_TOKEN\"] = worker_token\n",
      "print(\"Private worker token loaded through one-time secure bootstrap.\", flush=True)\n",
      "print(\"GPU available:\", torch.cuda.is_available())\n",
      "if torch.cuda.is_available(): print(\"GPU:\", torch.cuda.get_device_name(0))\n",
      "else: raise RuntimeError(\"No GPU detected. Enable a Kaggle GPU accelerator.\")\n"
    ];
  }

  if (tokenCell) {
    // Start a lightweight outbound heartbeat immediately after secure bootstrap.
    // Do not depend on a particular setup-cell title: the GPU preflight and
    // dependency installation can take several minutes before the worker polls.
    const heartbeat = [
      "import os, threading, urllib.request",
      'os.environ.setdefault("YT_AGENT_SERVER_URL", "https://ytagent-production-1038.up.railway.app")',
      'heartbeat_server = os.environ["YT_AGENT_SERVER_URL"].rstrip("/")',
      'heartbeat_token = os.environ["YT_AGENT_WORKER_TOKEN"]',
      'heartbeat_request = urllib.request.Request(heartbeat_server + "/api/worker/heartbeat", headers={"Authorization": "Bearer " + heartbeat_token})',
      'urllib.request.urlopen(heartbeat_request, timeout=20).read()',
      'print("YTAgent startup heartbeat confirmed.", flush=True)',
      "heartbeat_stop = threading.Event()",
      "def ytagent_heartbeat_loop():",
      "    while not heartbeat_stop.is_set():",
      '        try:',
      '            request = urllib.request.Request(heartbeat_server + "/api/worker/heartbeat", headers={"Authorization": "Bearer " + heartbeat_token})',
      '            urllib.request.urlopen(request, timeout=20).read()',
      '        except Exception as exc:',
      '            print("YTAgent heartbeat retry:", str(exc)[:120], flush=True)',
      "        heartbeat_stop.wait(5)",
      "heartbeat_thread = threading.Thread(target=ytagent_heartbeat_loop, daemon=True)",
      "heartbeat_thread.start()"
    ].join(String.fromCharCode(10)) + String.fromCharCode(10);
    const tokenSource = Array.isArray(tokenCell.source) ? tokenCell.source.join("") : tokenCell.source;
    tokenCell.source = tokenSource + heartbeat;
    // Keep the secure bootstrap first, followed by setup and the one-job runner.
    const markdown = notebook.cells.filter(item => item.cell_type !== "code");
    const code = notebook.cells.filter(item => item.cell_type === "code");
    notebook.cells = [...markdown, ...code.filter(item => item === tokenCell), ...code.filter(item => item !== tokenCell)];
  }

  const cell = notebook.cells.find(item => {
    if (!item || item.cell_type !== "code") return false;
    const cellSource = Array.isArray(item.source) ? item.source.join("") : item.source;
    return typeof cellSource === "string" && cellSource.includes("--run-once");
  });
  if (!cell) throw new Error("Kaggle worker notebook is missing its one-job runner cell.");
  cell.source = [
    'import os, sys, runpy\n',
    'os.environ["YT_AGENT_SERVER_URL"] = "https://ytagent-production-1038.up.railway.app"\n',
    'print("Starting YTAgent GPU worker inside the Kaggle notebook kernel.", flush=True)\n',
    'sys.argv = ["app.py", "--run-once", "--wait-seconds", "2700"]\n',
    'try:\n',
    '    runpy.run_path("app.py", run_name="__main__")\n',
    'finally:\n',
    '    if "heartbeat_stop" in globals(): heartbeat_stop.set()\n',
    '    if "heartbeat_thread" in globals(): heartbeat_thread.join(timeout=2)\n',
    'print("YTAgent GPU job finished.", flush=True)\n'
  ];  return JSON.stringify(notebook);
}

module.exports = { validateNotebookSource, buildNotebookSaveRequest, patchNotebookForBatchRun, MAX_NOTEBOOK_BYTES };
