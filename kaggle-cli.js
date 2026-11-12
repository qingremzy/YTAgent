"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs || 120000;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error(command + " exceeded its " + timeoutMs + " ms limit.");
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      const redact = value => String(value || "").replace(/KGAT_[A-Za-z0-9_-]{20,}/g, "[redacted Kaggle token]");
      if (code === 0) return resolve({ stdout: redact(stdout), stderr: redact(stderr) });
      const error = new Error(command + " exited with code " + code + ": " + redact(stderr || stdout).slice(-1800));
      error.exitCode = code;
      reject(error);
    });
  });
}

async function pushNotebookWithKaggleCli({ identity, source, metadata = {} }) {
  if (!process.env.KAGGLE_API_TOKEN) return null;
  try {
    await runCommand("kaggle", ["--version"], { timeoutMs: 15000 });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ytagent-kaggle-"));
  try {
    const codeFile = "YTAgent_Free_GPU_Worker.ipynb";
    const notebookPath = path.join(directory, codeFile);
    fs.writeFileSync(notebookPath, source, { mode: 0o600 });

    const machineShape = metadata.machineShape || metadata.machine_shape || "NvidiaTeslaT4";
    const timeoutSeconds = 32400;
    const kernelMetadata = {
      id: identity.slug,
      title: metadata.title || "YTAgent Free GPU Worker",
      code_file: codeFile,
      language: "python",
      kernel_type: "notebook",
      is_private: metadata.isPrivate ?? metadata.is_private ?? true,
      enable_gpu: true,
      enable_internet: true,
      machine_shape: machineShape,
      dataset_sources: metadata.datasetDataSources || metadata.dataset_data_sources || [],
      kernel_sources: metadata.kernelDataSources || metadata.kernel_data_sources || [],
      competition_sources: metadata.competitionDataSources || metadata.competition_data_sources || [],
      model_sources: metadata.modelDataSources || metadata.model_data_sources || [],
      category_ids: metadata.categoryIds || metadata.category_ids || []
    };
    fs.writeFileSync(path.join(directory, "kernel-metadata.json"), JSON.stringify(kernelMetadata, null, 2), { mode: 0o600 });

    const result = await runCommand("kaggle", [
      "kernels", "push", "-p", directory,
      "--timeout", String(timeoutSeconds),
      "--accelerator", machineShape
    ], { timeoutMs: 120000 });
    const combined = result.stdout + "\n" + result.stderr;
    const versionMatch = combined.match(/\\bversion(?:Number)?\\s*[:#]?\\s*(\\d+)/i);
    return {
      versionNumber: versionMatch ? Number(versionMatch[1]) : null,
      cli: true,
      timeoutSeconds,
      machineShape,
      message: "Kaggle CLI accepted the notebook push with the maximum 9-hour execution timeout.",
      output: combined.trim().slice(-1200)
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function getKaggleQuota() {
  if (!process.env.KAGGLE_API_TOKEN) throw new Error("Kaggle API token is not configured.");
  const result = await runCommand("kaggle", ["quota", "--format", "json"], { timeoutMs: 20000 });
  const output = result.stdout.trim();
  try { return JSON.parse(output); } catch (_) { return output; }
}

module.exports = { pushNotebookWithKaggleCli, getKaggleQuota };
