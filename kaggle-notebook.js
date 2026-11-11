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
    if (!cell || !["code", "markdown", "raw"].includes(cell.cell_type) || !(typeof cell.source === "string" || Array.isArray(cell.source))) {
      throw new Error("Notebook cell " + (index + 1) + " has an invalid type or source.");
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
  return {
    slug,
    newTitle: get("title", "title", "YTAgent Free GPU Worker"),
    text: source,
    language: get("language", "language", "python"),
    kernelType: get("kernelType", "kernel_type", "notebook"),
    isPrivate: get("isPrivate", "is_private", true),
    enableGpu: get("enableGpu", "enable_gpu", Boolean(machineShape)),
    enableInternet: get("enableInternet", "enable_internet", true),
    machineShape,
    datasetDataSources: get("datasetDataSources", "dataset_data_sources", []),
    kernelDataSources: get("kernelDataSources", "kernel_data_sources", []),
    competitionDataSources: get("competitionDataSources", "competition_data_sources", []),
    modelDataSources: get("modelDataSources", "model_data_sources", []),
    categoryIds: get("categoryIds", "category_ids", []),
    kernelExecutionType: "SaveAndRunAll",
    hasKernelExecutionType: true,
    sessionTimeoutSeconds: 43200,
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

module.exports = { validateNotebookSource, buildNotebookSaveRequest, MAX_NOTEBOOK_BYTES };
