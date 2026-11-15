"use strict";

const DEFAULT_TIMEOUT_MS = 10000;

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) { throw new Error("QingCloud URL must be a valid absolute URL."); }
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("QingCloud must use HTTPS unless it is running on localhost.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("QingCloud URL must not contain credentials, query parameters or fragments.");
  }
  return raw;
}

function createQingCloudClient(env = process.env, fetchImpl = globalThis.fetch) {
  const baseUrl = normalizeBaseUrl(env.QINGCLOUD_URL);
  const adminToken = String(env.QINGCLOUD_ADMIN_TOKEN || "");
  const configured = Boolean(baseUrl && adminToken);

  async function request(path, options = {}) {
    if (!configured) throw new Error("QingCloud is not configured. Set QINGCLOUD_URL and QINGCLOUD_ADMIN_TOKEN on the YTAgent server.");
    if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch().");
    const response = await fetchImpl(baseUrl + path, {
      method: options.method || "GET",
      headers: {
        "X-QingCloud-Admin-Token": adminToken,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.headers || {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS)
    });
    const raw = await response.text();
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); }
      catch (_) { throw new Error("QingCloud returned an invalid response."); }
    }
    if (!response.ok) {
      const detail = typeof body.detail === "string" ? body.detail : "QingCloud request failed.";
      throw new Error("QingCloud HTTP " + response.status + ": " + detail.slice(0, 240));
    }
    return body;
  }

  return {
    configured,
    baseUrl,
    async status() {
      if (!configured) return { configured: false, connected: false, message: "QingCloud connection is not configured." };
      const health = await request("/health", { headers: {} });
      const overview = await request("/v1/overview");
      return { configured: true, connected: health.status === "ok", health, overview };
    },
    createDistributedSum({ start, end, chunk_size = 1000 }) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
        throw new Error("A valid inclusive integer range is required.");
      }
      if (end - start + 1 > 1000000) throw new Error("QingCloud test range cannot exceed 1,000,000 integers.");
      if (!Number.isInteger(chunk_size) || chunk_size < 1 || chunk_size > 10000) {
        throw new Error("Chunk size must be between 1 and 10,000.");
      }
      return request("/v1/distributed/sum", {
        method: "POST",
        body: { start, end, chunk_size }
      });
    },
    listProviders() {
      return request("/v1/providers");
    },
    updateProviderApproval(workerId, status, note = "") {
      if (!/^[a-f0-9-]{36}$/i.test(String(workerId || ""))) {
        throw new Error("Invalid QingCloud worker ID.");
      }
      if (!["pending", "approved", "rejected"].includes(status)) {
        throw new Error("Provider approval status must be pending, approved or rejected.");
      }
      return request("/v1/workers/" + encodeURIComponent(workerId) + "/approval", {
        method: "PUT",
        body: { status, note: String(note || "").slice(0, 500) }
      });
    },
    getDistributedSum(taskId) {
      if (!/^[a-f0-9-]{16,64}$/i.test(String(taskId || ""))) {
        throw new Error("Invalid QingCloud task ID.");
      }
      return request("/v1/distributed/sum/" + encodeURIComponent(taskId));
    }
  };
}

module.exports = { createQingCloudClient, normalizeBaseUrl };
