"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createQingCloudClient, normalizeBaseUrl } = require("./qingcloud-client");

function fakeFetch(routes, seen = []) {
  return async (url, options = {}) => {
    seen.push({ url, options });
    const route = routes[url];
    if (!route) return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status || 200 });
  };
}

test("QingCloud URL requires HTTPS for remote hosts", () => {
  assert.throws(() => normalizeBaseUrl("http://compute.example.com"), /HTTPS/);
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8000/"), "http://127.0.0.1:8000");
  assert.equal(normalizeBaseUrl("https://compute.example.com/"), "https://compute.example.com");
});

test("unconfigured client reports disabled without making a request", async () => {
  const client = createQingCloudClient({});
  assert.equal(client.configured, false);
  assert.deepEqual(await client.status(), {
    configured: false, connected: false,
    message: "QingCloud connection is not configured."
  });
  await assert.rejects(client.getDistributedSum("12345678-1234-1234-1234-123456789abc"), /not configured/);
});

test("status authenticates overview and reports provider inventory", async () => {
  const seen = [];
  const base = "https://compute.example.com";
  const client = createQingCloudClient({
    QINGCLOUD_URL: base, QINGCLOUD_ADMIN_TOKEN: "server-only-secret"
  }, fakeFetch({
    [base + "/health"]: { body: { status: "ok", service: "qingcloud-compute" } },
    [base + "/v1/overview"]: { body: { online_workers: 2, queued_jobs: 1 } }
  }, seen));
  const result = await client.status();
  assert.equal(result.connected, true);
  assert.equal(result.overview.online_workers, 2);
  assert.equal(seen[1].options.headers["X-QingCloud-Admin-Token"], "server-only-secret");
});

test("distributed sum submission validates input and sends admin-authenticated request", async () => {
  const seen = [];
  const base = "https://compute.example.com";
  const client = createQingCloudClient({
    QINGCLOUD_URL: base, QINGCLOUD_ADMIN_TOKEN: "private"
  }, fakeFetch({
    [base + "/v1/distributed/sum"]: { body: { task_id: "12345678-1234-1234-1234-123456789abc", chunk_count: 10 } }
  }, seen));
  const result = await client.createDistributedSum({ start: 1, end: 1000, chunk_size: 100 });
  assert.equal(result.chunk_count, 10);
  assert.equal(seen[0].options.method, "POST");
  assert.deepEqual(JSON.parse(seen[0].options.body), { start: 1, end: 1000, chunk_size: 100 });
  assert.equal(seen[0].options.headers["X-QingCloud-Admin-Token"], "private");
  assert.throws(() => client.createDistributedSum({ start: 10, end: 1 }), /valid inclusive/);
  assert.throws(() => client.createDistributedSum({ start: 1, end: 1000001 }), /cannot exceed/);
});

test("task status rejects malformed IDs and reports coordinator errors safely", async () => {
  const base = "https://compute.example.com";
  const client = createQingCloudClient({
    QINGCLOUD_URL: base, QINGCLOUD_ADMIN_TOKEN: "private"
  }, fakeFetch({
    [base + "/v1/distributed/sum/12345678-1234-1234-1234-123456789abc"]: {
      status: 401, body: { detail: "Invalid admin token" }
    }
  }));
  await assert.rejects(client.getDistributedSum("../secrets"), /Invalid QingCloud task ID/);
  await assert.rejects(client.getDistributedSum("12345678-1234-1234-1234-123456789abc"), /HTTP 401: Invalid admin token/);
});
