const KAGGLE_MCP_URL = "https://www.kaggle.com/mcp";

function parseMcpPayload(response, raw) {
  const type = response.headers.get("content-type") || "";
  if (type.includes("text/event-stream")) {
    const payloads = raw.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean);
    for (const payload of payloads.reverse()) {
      try { return JSON.parse(payload); } catch (_) {}
    }
    throw new Error("Kaggle returned an unreadable MCP event stream.");
  }
  try { return JSON.parse(raw); } catch (_) {
    throw new Error("Kaggle returned an unreadable MCP response.");
  }
}

async function postMcp(token, body, sessionId) {
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
    headers["MCP-Protocol-Version"] = "2025-03-26";
  }
  const response = await fetch(KAGGLE_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });
  const raw = await response.text();
  if (!response.ok) {
    const detail = raw.replace(/\s+/g, " ").slice(0, 240);
    if (response.status === 401 || response.status === 403) {
      throw new Error("Kaggle rejected the API token or it lacks permission. Generate a fresh token in Kaggle Settings.");
    }
    throw new Error("Kaggle MCP returned HTTP " + response.status + (detail ? ": " + detail : ""));
  }
  return {
    payload: raw ? parseMcpPayload(response, raw) : null,
    sessionId: response.headers.get("mcp-session-id") || sessionId || null
  };
}

async function listKaggleTools() {
  const token = String(process.env.KAGGLE_API_TOKEN || "").trim();
  if (!token) throw new Error("KAGGLE_API_TOKEN is not configured in Railway.");
  if (!token.startsWith("KGAT_")) throw new Error("KAGGLE_API_TOKEN must be a Kaggle personal access token beginning with KGAT_.");

  const initialized = await postMcp(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "YTAgent", version: "1.0.0" }
    }
  });
  if (initialized.payload?.error) {
    throw new Error(initialized.payload.error.message || "Kaggle MCP initialization failed.");
  }
  const sessionId = initialized.sessionId;
  await postMcp(token, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  }, sessionId);

  const listed = await postMcp(token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  }, sessionId);
  if (listed.payload?.error) {
    throw new Error(listed.payload.error.message || "Kaggle tool discovery failed.");
  }
  const tools = listed.payload?.result?.tools;
  if (!Array.isArray(tools)) throw new Error("Kaggle connected, but returned no tool list.");
  return tools.map(tool => ({
    name: String(tool.name || ""),
    description: String(tool.description || "").slice(0, 500)
  })).filter(tool => tool.name);
}



async function callKaggleTool(toolName, request = {}) {
  const token = String(process.env.KAGGLE_API_TOKEN || "").trim();
  if (!token) throw new Error("KAGGLE_API_TOKEN is not configured in Railway.");
  if (!token.startsWith("KGAT_")) throw new Error("KAGGLE_API_TOKEN must be a Kaggle personal access token beginning with KGAT_.");
  const initialized = await postMcp(token, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "YTAgent", version: "1.0.0" }
    }
  });
  if (initialized.payload?.error) {
    throw new Error(initialized.payload.error.message || "Kaggle MCP initialization failed.");
  }
  const sessionId = initialized.sessionId;
  await postMcp(token, {
    jsonrpc: "2.0", method: "notifications/initialized", params: {}
  }, sessionId);
  const called = await postMcp(token, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: toolName, arguments: { request } }
  }, sessionId);
  if (called.payload?.error) {
    throw new Error(called.payload.error.message || ("Kaggle tool failed: " + toolName));
  }
  const result = called.payload?.result;
  if (!result) throw new Error("Kaggle returned no result for " + toolName + ".");
  if (result.isError) {
    const message = (result.content || []).map(item => item.text || "").filter(Boolean).join(" ").slice(0, 500);
    throw new Error(message || ("Kaggle tool failed: " + toolName));
  }
  return result;
}

module.exports = { listKaggleTools, callKaggleTool };

