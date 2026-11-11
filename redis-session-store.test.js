const test = require("node:test");
const assert = require("node:assert/strict");
const { RedisStore } = require("connect-redis");

test("connect-redis v8 exposes a session store compatible with an ioredis-style client", () => {
  assert.equal(typeof RedisStore, "function");
  const client = {
    get: async () => null,
    set: async () => "OK",
    del: async () => 1,
    expire: async () => 1
  };
  const store = new RedisStore({ client, prefix: "ytagent:test:", ttl: 60 });
  assert.ok(store instanceof RedisStore);
});
