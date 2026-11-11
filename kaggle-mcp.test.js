const test = require("node:test");
const assert = require("node:assert/strict");
const { callKaggleTool, toKaggleFieldNames } = require("./kaggle-mcp");

test("callKaggleTool initializes MCP and sends a notebook request", async () => {
  const previousFetch = global.fetch;
  const previousToken = process.env.KAGGLE_API_TOKEN;
  const calls = [];
  process.env.KAGGLE_API_TOKEN = "KGAT_test-token";
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ body, headers: options.headers });
    if (body.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }), {
        status: 200, headers: { "content-type": "application/json", "mcp-session-id": "test-session" }
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response("data: " + JSON.stringify({
      jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "RUNNING" }] }
    }) + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const result = await callKaggleTool("get_notebook_session_status", { userName: "samsonbamigboye", kernelSlug: "notebook477419e21e" });
    assert.equal(result.content[0].text, "RUNNING");
    assert.equal(calls.length, 3);
    assert.equal(calls[2].body.method, "tools/call");
    assert.equal(calls[2].body.params.name, "get_notebook_session_status");
    assert.deepEqual(calls[2].body.params.arguments.request, {
      user_name: "samsonbamigboye", kernel_slug: "notebook477419e21e"
    });
    assert.equal(calls[2].headers["Mcp-Session-Id"], "test-session");
  } finally {
    global.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.KAGGLE_API_TOKEN;
    else process.env.KAGGLE_API_TOKEN = previousToken;
  }
});

test("callKaggleTool refuses missing Kaggle credentials", async () => {
  const previousToken = process.env.KAGGLE_API_TOKEN;
  delete process.env.KAGGLE_API_TOKEN;
  try {
    await assert.rejects(() => callKaggleTool("get_notebook_info", {}), /KAGGLE_API_TOKEN is not configured/);
  } finally {
    if (previousToken === undefined) delete process.env.KAGGLE_API_TOKEN;
    else process.env.KAGGLE_API_TOKEN = previousToken;
  }
});


test("toKaggleFieldNames converts nested camelCase fields to Kaggle API snake_case", () => {
  assert.deepEqual(toKaggleFieldNames({
    userName: "samsonbamigboye",
    kernelSlug: "notebook477419e21e",
    enableInternet: true,
    nestedOptions: [{ machineShape: "GPU" }]
  }), {
    user_name: "samsonbamigboye",
    kernel_slug: "notebook477419e21e",
    enable_internet: true,
    nested_options: [{ machine_shape: "GPU" }]
  });
});
