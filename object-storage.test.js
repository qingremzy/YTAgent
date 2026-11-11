const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createObjectStorage, normalizeObjectKey } = require("./object-storage");

test("R2 storage stays optional when credentials are absent", async () => {
  const storage = createObjectStorage({ env: {} });
  assert.equal(storage.configured, false);
  assert.equal(await storage.putBuffer("videos/a.mp4", Buffer.from("x")), false);
  assert.equal(await storage.getObject("videos/a.mp4"), null);
  assert.deepEqual(await storage.listKeys("videos"), []);
});

test("rejects traversal and malformed object keys", () => {
  assert.equal(normalizeObjectKey("/studio/abc/project.json"), "studio/abc/project.json");
  assert.throws(() => normalizeObjectKey("../secret"), /Invalid object storage key/);
  assert.throws(() => normalizeObjectKey("studio//project.json"), /Invalid object storage key/);
  assert.throws(() => normalizeObjectKey("studio/./project.json"), /Invalid object storage key/);
});

test("uploads files and buffers to the configured bucket", async () => {
  const calls = [];
  const client = { send: async command => { calls.push(command); return {}; } };
  const storage = createObjectStorage({
    env: { R2_BUCKET_NAME: "ytagent" },
    client
  });
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-r2-test-"));
  try {
    const file = path.join(dir, "scene.mp4");
    await fs.promises.writeFile(file, Buffer.from("video-content"));
    await storage.putFile("studio/abc/scene-01.mp4", file);
    await storage.putBuffer("studio/abc/project.json", Buffer.from("{}"), "application/json");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].input.Bucket, "ytagent");
    assert.equal(calls[0].input.Key, "studio/abc/scene-01.mp4");
    assert.equal(calls[0].input.ContentType, "video/mp4");
    assert.equal(calls[1].input.Key, "studio/abc/project.json");
    assert.equal(calls[1].input.ContentType, "application/json");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("reads stored JSON and streams missing-object results as null", async () => {
  const client = {
    send: async command => {
      if (command.constructor.name === "GetObjectCommand") {
        if (command.input.Key === "missing.json") {
          const error = new Error("missing");
          error.name = "NoSuchKey";
          throw error;
        }
        return { Body: (async function* () { yield Buffer.from('{"ok":true}'); })() };
      }
      return {};
    }
  };
  const storage = createObjectStorage({ env: { R2_BUCKET_NAME: "ytagent" }, client });
  assert.deepEqual(await storage.getJson("studio/abc/project.json"), { ok: true });
  assert.equal(await storage.getObject("missing.json"), null);
});

test("uploads every regular file in a project directory", async () => {
  const calls = [];
  const client = { send: async command => { calls.push(command); return {}; } };
  const storage = createObjectStorage({ env: { R2_BUCKET_NAME: "ytagent" }, client });
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ytagent-r2-dir-"));
  try {
    await fs.promises.mkdir(path.join(dir, "nested"));
    await fs.promises.writeFile(path.join(dir, "project.json"), "{}");
    await fs.promises.writeFile(path.join(dir, "nested", "scene.wav"), "audio");
    const uploaded = await storage.uploadDirectory(dir, "studio/abc");
    assert.equal(uploaded.length, 2);
    assert.ok(uploaded.includes("studio/abc/project.json"));
    assert.ok(uploaded.includes("studio/abc/nested/scene.wav"));
    assert.equal(calls.length, 2);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("checks whether an R2 object already exists", async () => {
  const client = {
    send: async command => {
      if (command.constructor.name === "HeadObjectCommand" && command.input.Key === "missing") {
        const error = new Error("missing");
        error.name = "NotFound";
        throw error;
      }
      return {};
    }
  };
  const storage = createObjectStorage({ env: { R2_BUCKET_NAME: "ytagent" }, client });
  assert.equal(await storage.exists("studio/abc/scene-01.mp4"), true);
  assert.equal(await storage.exists("missing"), false);
});
