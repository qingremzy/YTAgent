"use strict";

const ACTIVE_SESSION_STATES = new Set(["RUNNING", "QUEUED", "CANCEL_REQUESTED"]);

function createKaggleWorkerSessionManager({
  callKaggleTool,
  getGpuWorkerStatus,
  getNotebookIdentity,
  getNotebookSource,
  getBootstrapToken,
  pushNotebookWithCli,
  getKaggleKernelStatus,
  statusPollIntervalMs = 30000,
  kaggleToolData = value => value
}) {
  if (typeof callKaggleTool !== "function" ||
      typeof getNotebookIdentity !== "function") {
    throw new TypeError("Kaggle worker session manager requires tool and notebook identity functions.");
  }
  let startPromise = null;
  let lastStartAt = 0;
  let statusTimer = null;
  let statusPollInFlight = false;

  function stopStatusMonitor() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
  }

  function parseKernelState(value) {
    const raw = String(value || "");
    const match = raw.match(/KernelWorkerStatus\.([A-Z_]+)/i) ||
      raw.match(/\b(QUEUED|RUNNING|COMPLETE|ERROR|CANCEL_REQUESTED|CANCEL_ACKNOWLEDGED|NEW_SCRIPT)\b/i);
    return match ? match[1].toUpperCase() : "UNKNOWN";
  }

  function startStatusMonitor(identity, onStatus) {
    if (typeof getKaggleKernelStatus !== "function" || statusTimer) return;
    const poll = async () => {
      if (statusPollInFlight) return;
      const workerStatus = typeof getGpuWorkerStatus === "function" ? getGpuWorkerStatus() : null;
      if (workerStatus?.online) {
        stopStatusMonitor();
        return;
      }
      statusPollInFlight = true;
      try {
        const result = await getKaggleKernelStatus(identity);
        const raw = typeof result === "string" ? result : (result?.status || "");
        const state = parseKernelState(raw);
        console.log("YTAgent Kaggle live kernel status:", state, String(raw).slice(-350));
        if (typeof onStatus === "function") {
          try {
            await onStatus({ state, raw: String(raw).slice(-1000), terminal: ["COMPLETE", "ERROR", "CANCEL_ACKNOWLEDGED"].includes(state) });
          } catch (error) {
            console.error("YTAgent Kaggle status callback failed:", error.message || error);
          }
        }
        if (["COMPLETE", "ERROR", "CANCEL_ACKNOWLEDGED"].includes(state)) {
          stopStatusMonitor();
          lastStartAt = 0;
          console.error("YTAgent Kaggle notebook ended before the worker connected:", state);
        }
      } catch (error) {
        console.error("YTAgent Kaggle status poll failed; retaining the existing run:", String(error.message || error).slice(0, 300));
      } finally {
        statusPollInFlight = false;
      }
    };
    void poll();
    statusTimer = setInterval(poll, Math.max(5000, Number(statusPollIntervalMs) || 30000));
    if (statusTimer.unref) statusTimer.unref();
  }

  async function startIfNeeded({ onStatus } = {}) {
    const identity = getNotebookIdentity();
    const workerStatus = typeof getGpuWorkerStatus === "function" ? getGpuWorkerStatus() : null;
    if (workerStatus?.online) {
      stopStatusMonitor();
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

    startStatusMonitor(identity, onStatus);
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

  async function ensure(options = {}) {
    const workerStatus = typeof getGpuWorkerStatus === "function" ? getGpuWorkerStatus() : null;
    if (workerStatus?.online) {
      stopStatusMonitor();
      return {
        started: false,
        alreadyRunning: true,
        workerOnline: true,
        workerStatus,
        message: "The free GPU worker is already online."
      };
    }
    if (startPromise) return startPromise;
    startPromise = startIfNeeded(options);
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  return { ensure, stopStatusMonitor };
}

module.exports = { createKaggleWorkerSessionManager, ACTIVE_SESSION_STATES };
