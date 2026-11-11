const test = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimiter } = require("./rate-limit");

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("allows requests within the configured limit", () => {
  const limit = createRateLimiter({ limit: 2, windowMs: 60000, message: "Slow down." });
  let nextCalls = 0;
  for (let i = 0; i < 2; i++) {
    const res = responseRecorder();
    limit({ ip: "192.0.2.1" }, res, () => nextCalls++);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(nextCalls, 2);
});

test("blocks requests above the limit and returns Retry-After", () => {
  const limit = createRateLimiter({ limit: 1, windowMs: 60000, message: "Too many requests." });
  const req = { ip: "192.0.2.2" };
  limit(req, responseRecorder(), () => {});
  const res = responseRecorder();
  let nextCalled = false;
  limit(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["Retry-After"], "60");
  assert.match(res.body.error, /Too many requests/);
});

test("tracks different client IPs separately", () => {
  const limit = createRateLimiter({ limit: 1, windowMs: 60000, message: "Too many requests." });
  for (const ip of ["192.0.2.3", "192.0.2.4"]) {
    const res = responseRecorder();
    let nextCalled = false;
    limit({ ip }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  }
});
