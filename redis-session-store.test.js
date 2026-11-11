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

test("persists and retrieves a session through RedisStore", async () => {
  const values = new Map();
  const client = {
    get: async key => values.get(key) || null,
    set: async (key, value) => { values.set(key, value); return "OK"; },
    del: async key => values.delete(key) ? 1 : 0,
    expire: async () => 1,
    on: () => client
  };
  const store = new RedisStore({ client, prefix: "ytagent:test:", ttl: 60 });
  await new Promise((resolve, reject) => {
    store.set("session-1", { cookie: { expires: null }, user: "test-user" }, error => error ? reject(error) : resolve());
  });
  const restored = await new Promise((resolve, reject) => {
    store.get("session-1", (error, value) => error ? reject(error) : resolve(value));
  });
  assert.equal(restored.user, "test-user");
  assert.ok(values.has("ytagent:test:session-1"));
});
