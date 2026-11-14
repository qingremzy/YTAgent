"use strict";

const ACTIVE_SESSION_STATES = new Set(["RUNNING", "QUEUED", "CANCEL_REQUESTED"]);

function createKaggleWorkerSessionManager({
  callKaggleTool,
  getGpuWorkerStatus,
  getNotebookIdentity,
  getNotebookSource,
  getBootstrapToken,
  pushNotebookWithCli,
  kaggleToolData = value => value
}) {
  if (typeof callKaggleTool !== "function" ||
      typeof getNotebookIdentity !== "function") {
    throw new TypeError("Kaggle worker session manager requires tool and notebook identity functions.");
  }
  let startPromise = null;
  let lastStartAt = 0;

  async function startIfNeeded() {
    const identity = getNotebookIdentity();
    const workerStatus = typeof getGpuWorkerStatus === "function" ? getGpuWorkerStatus() : null;
    if (workerStatus?.online) {
      return {
        started: false,
        alreadyRunning: true,
        workerOnline: true,
        workerStatus,
        notebookRef: identity.slug,
        message: "The free GPU worker is already online."
      };
    }

    const now = Date.now();
    // A queued Kaggle run is still consuming the account's one active launch slot.
    // Do not submit another version while the previous 45-minute startup window is open.
    const activeRunWindowMs = 45 * 60 * 1000;
    if (lastStartAt && now - lastStartAt < activeRunWindowMs) {
      return {
        started: false,
        alreadyRunning: true,
        notebookRef: identity.slug,
        retryAfterMs: Math.max(0, activeRunWindowMs - (now - lastStartAt)),
        message: "A Kaggle GPU notebook run is still within its startup window. Waiting for its worker heartbeat instead of submitting a duplicate run."
      };
    }

    const info = kaggleToolData(await callKaggleTool("get_notebook_info", {
      userName: identity.userName,
      kernelSlug: identity.kernelSlug
    }));
    const metadata = info?.metadata || info?.kernel?.metadata || {};
    const machineShape = metadata.machineShape || metadata.machine_shape || "";
    if (!machineShape) {
      throw new Error("Kaggle did not report a GPU machine shape. Save a notebook version with a GPU accelerator first.");
    }

    // The GitHub notebook is the source of truth. Kaggle's saved copy can lag behind
    // repository fixes, which previously caused old setup cells to run on every job.
    const savedSource = info?.blob?.source || info?.kernel?.blob?.source || "";
    const source = typeof getNotebookSource === "function"
      ? await getNotebookSource(identity)
      : savedSource;
    if (!source) {
      throw new Error("The canonical YTAgent Kaggle notebook source is unavailable.");
    }
    const { validateNotebookSource, buildNotebookSaveRequest, patchNotebookForBatchRun } = require("./kaggle-notebook");
    const bootstrapToken = typeof getBootstrapToken === "function"
      ? await getBootstrapToken(identity)
      : null;
    const runnableSource = patchNotebookForBatchRun(source, {
      bootstrapToken,
      serverUrl: process.env.APP_URL || "https://ytagent-production-1038.up.railway.app"
    });
    validateNotebookSource(runnableSource);
    const request = buildNotebookSaveRequest(identity.slug, runnableSource, metadata);
    request.kernelExecutionType = "SaveAndRunAll";

    // Kaggle's interactive-session API only opens a Jupyter session; it does not
    // execute the notebook cells. SaveAndRunAll actually launches the GPU worker.
    lastStartAt = now;
    let operation;
    try {
      operation = typeof pushNotebookWithCli === "function"
        ? await pushNotebookWithCli({ identity, source: runnableSource, metadata })
        : null;
      if (operation === null) {
        operation = kaggleToolData(await callKaggleTool("save_notebook", request));
      }
    } catch (error) {
      lastStartAt = 0;
      throw error;
    }
    if (operation?.error) {
      lastStartAt = 0;
      throw new Error(String(operation.error));
    }
    console.log("YTAgent Kaggle launch method:", operation?.cli ? "Kaggle CLI" : "Kaggle MCP", "version:", operation?.versionNumber || operation?.version_number || "pending", "timeoutSeconds:", operation?.timeoutSeconds || request.sessionTimeoutSeconds || "provider default");
    if (operation?.runStatus) console.log("YTAgent Kaggle execution status after push:", String(operation.runStatus).slice(0, 500));

    return {
      started: true,
      alreadyRunning: false,
      notebookRef: identity.slug,
      machineShape,
      versionNumber: operation?.versionNumber || operation?.version_number || null,
      operation,
      message: "YTAgent launched the saved Kaggle notebook as a GPU execution run."
    };
  }

  async function ensure() {
    const workerStatus = typeof getGpuWorkerStatus === "function" ? getGpuWorkerStatus() : null;
    if (workerStatus?.online) {
      return {
        started: false,
        alreadyRunning: true,
        workerOnline: true,
        workerStatus,
        message: "The free GPU worker is already online."
      };
    }
    if (startPromise) return startPromise;
    startPromise = startIfNeeded();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  return { ensure };
}

module.exports = { createKaggleWorkerSessionManager, ACTIVE_SESSION_STATES };
