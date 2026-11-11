"use strict";

const ACTIVE_SESSION_STATES = new Set(["RUNNING", "QUEUED", "CANCEL_REQUESTED"]);

function createKaggleWorkerSessionManager({
  callKaggleTool,
  getGpuWorkerStatus,
  getNotebookIdentity,
  kaggleToolData = value => value
}) {
  if (typeof callKaggleTool !== "function" ||
      typeof getNotebookIdentity !== "function") {
    throw new TypeError("Kaggle worker session manager requires tool and notebook identity functions.");
  }
  let startPromise = null;

  async function startIfNeeded() {
    const identity = getNotebookIdentity();
    const status = await callKaggleTool("get_notebook_session_status", {
      userName: identity.userName,
      kernelSlug: identity.kernelSlug
    }).then(kaggleToolData).catch(error => ({ lookupError: error.message }));

    const statusText = String(status?.status || status?.state || status?.message || "").toUpperCase();
    if (ACTIVE_SESSION_STATES.has(statusText)) {
      return {
        started: false,
        alreadyRunning: true,
        notebookRef: identity.slug,
        session: status,
        message: "Kaggle already has an active notebook session."
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

    const operation = kaggleToolData(await callKaggleTool("create_notebook_session", {
      slug: identity.slug,
      language: metadata.language || "python",
      kernelType: metadata.kernelType || metadata.kernel_type || "notebook",
      machineShape,
      enableInternet: metadata.enableInternet ?? metadata.enable_internet ?? true
    }));

    return {
      started: true,
      alreadyRunning: false,
      notebookRef: identity.slug,
      machineShape,
      operation,
      message: "YTAgent started the saved Kaggle notebook session."
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
