const test = require("node:test");
const assert = require("node:assert/strict");
const { requestJson, isQueueFullError } = require("./agnes");

test("preserves plain-text Agnes queue-full errors for retry detection", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response("video queue is full, please retry later", { status: 429 });
  try {
    await assert.rejects(
      requestJson("https://example.test/submit", {}, "Agnes video submission"),
      error => error.status === 429 && isQueueFullError(error) && /video queue is full/i.test(error.message)
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("preserves plain-text transient provider errors", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response("temporarily unavailable", { status: 503 });
  try {
    await assert.rejects(
      requestJson("https://example.test/submit", {}, "Agnes video submission"),
      error => error.status === 503 && /temporarily unavailable/i.test(error.message)
    );
  } finally {
    global.fetch = originalFetch;
  }
});
