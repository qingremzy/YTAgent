"use strict";

// YTAgent's free-provider adaptation of Forge Film's DAG + Critical Path Method.
// This module contains no model/API integrations. It only validates dependencies,
// ranks ready work, and prevents descendants from running after a failed scene.

function validateDag(dag) {
  if (!dag || typeof dag !== "object" || Array.isArray(dag)) {
    throw new TypeError("DAG must be an object of node IDs to downstream node IDs.");
  }
  const nodes = new Set(Object.keys(dag));
  for (const [source, targets] of Object.entries(dag)) {
    if (!Array.isArray(targets)) throw new TypeError("DAG edges for " + source + " must be an array.");
    for (const target of targets) {
      if (!nodes.has(target)) throw new Error("DAG references unknown node: " + target);
    }
  }
  const indegree = Object.fromEntries([...nodes].map(id => [id, 0]));
  for (const targets of Object.values(dag)) for (const target of targets) indegree[target]++;
  const queue = Object.keys(indegree).filter(id => indegree[id] === 0);
  let visited = 0;
  while (queue.length) {
    const node = queue.shift();
    visited++;
    for (const target of dag[node]) {
      indegree[target]--;
      if (indegree[target] === 0) queue.push(target);
    }
  }
  if (visited !== nodes.size) throw new Error("DAG contains a cycle.");
  return true;
}

function computeCriticalPath(dag, durations = {}) {
  validateDag(dag);
  const indegree = Object.fromEntries(Object.keys(dag).map(id => [id, 0]));
  for (const targets of Object.values(dag)) for (const target of targets) indegree[target]++;
  const queue = Object.keys(dag).filter(id => indegree[id] === 0);
  const topo = [];
  while (queue.length) {
    const node = queue.shift();
    topo.push(node);
    for (const target of dag[node]) {
      indegree[target]--;
      if (indegree[target] === 0) queue.push(target);
    }
  }
  const remaining = {};
  for (const node of topo.reverse()) {
    const own = Math.max(0, Number(durations[node]) || 0);
    remaining[node] = own + Math.max(0, ...dag[node].map(next => remaining[next] || 0));
  }
  return remaining;
}

function getReadyPriorityQueue(dag, durations = {}) {
  const priority = computeCriticalPath(dag, durations);
  return Object.entries(priority)
    .map(([id, seconds]) => ({ id, priority: seconds }))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

// Executes independent nodes concurrently. Failed dependencies are marked
// blocked and never passed to generateFn. The caller controls concurrency so
// one-GPU workers can safely use maxWorkers=1.
async function runDag({ dag, durations = {}, maxWorkers = 1, generateFn, onEvent = () => {} }) {
  validateDag(dag);
  if (typeof generateFn !== "function") throw new TypeError("generateFn must be a function.");
  const limit = Math.max(1, Math.floor(Number(maxWorkers) || 1));
  const dependencies = Object.fromEntries(Object.keys(dag).map(id => [id, []]));
  for (const [source, targets] of Object.entries(dag)) {
    for (const target of targets) dependencies[target].push(source);
  }
  const priority = computeCriticalPath(dag, durations);
  const state = Object.fromEntries(Object.keys(dag).map(id => [id, "pending"]));
  const results = {};
  const errors = {};
  const running = new Map();

  const emit = (type, id, detail) => {
    try { onEvent({ type, id, detail, state: { ...state } }); } catch (_) {}
  };

  while (true) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of Object.keys(dag)) {
        if (state[id] !== "pending") continue;
        if (dependencies[id].some(dep => state[dep] === "failed" || state[dep] === "blocked")) {
          state[id] = "blocked";
          errors[id] = new Error("Blocked because a prerequisite scene failed.");
          emit("blocked", id, errors[id].message);
          changed = true;
        }
      }
    }

    const ready = Object.keys(dag)
      .filter(id => state[id] === "pending" && dependencies[id].every(dep => state[dep] === "succeeded"))
      .sort((a, b) => (priority[b] || 0) - (priority[a] || 0) || a.localeCompare(b));

    while (ready.length && running.size < limit) {
      const id = ready.shift();
      state[id] = "running";
      emit("started", id);
      const task = Promise.resolve()
        .then(() => generateFn(id))
        .then(value => {
          state[id] = "succeeded";
          results[id] = value;
          emit("succeeded", id);
        }, error => {
          state[id] = "failed";
          errors[id] = error instanceof Error ? error : new Error(String(error));
          emit("failed", id, errors[id].message);
        })
        .finally(() => running.delete(id));
      running.set(id, task);
    }

    if (!running.size) break;
    await Promise.race(running.values());
  }

  const pending = Object.keys(state).filter(id => state[id] === "pending");
  if (pending.length) throw new Error("DAG scheduler stalled with pending nodes: " + pending.join(", "));
  return { results, errors, state, failed: Object.keys(state).filter(id => state[id] === "failed" || state[id] === "blocked") };
}

module.exports = { validateDag, computeCriticalPath, getReadyPriorityQueue, runDag };
