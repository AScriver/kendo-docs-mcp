const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body
  ]);
}

function decodeMessages(buffer) {
  const messages = [];
  let remaining = buffer;

  while (true) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      break;
    }
    const header = remaining.slice(0, headerEnd).toString("utf8");
    const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      remaining = remaining.slice(headerEnd + 4);
      continue;
    }
    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) {
      break;
    }
    messages.push(JSON.parse(remaining.slice(bodyStart, bodyEnd).toString("utf8")));
    remaining = remaining.slice(bodyEnd);
  }

  return { messages, remaining };
}

function toolResult(response) {
  if (response.error) {
    throw new Error(response.error.message || JSON.stringify(response.error));
  }
  if (response.result && response.result.structuredContent && response.result.structuredContent.result !== undefined) {
    return response.result.structuredContent.result;
  }
  const text = response.result && response.result.content && response.result.content[0] && response.result.content[0].text;
  return text ? JSON.parse(text) : null;
}

function summarizeSmokeResult({ toolNames, versions, searchResultCount }) {
  const toolText = `${toolNames.length} ${toolNames.length === 1 ? "tool was" : "tools were"} listed`;
  if (!versions.length) {
    return `MCP protocol responded and ${toolText}. No docs corpus was found, so search was skipped.`;
  }
  return `MCP protocol responded, ${toolText}, ${versions.length} docs ${versions.length === 1 ? "corpus was" : "corpora were"} found, and a search returned ${searchResultCount} ${searchResultCount === 1 ? "result" : "results"}.`;
}

function send(child, message) {
  child.stdin.write(encodeMessage(message));
}

function waitForMessage(state, id, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const existing = state.messages.find((message) => message.id === id);
    if (existing) {
      resolve(existing);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response id ${id}`));
    }, timeoutMs);

    function onMessage(message) {
      if (message.id === id) {
        cleanup();
        resolve(message);
      }
    }

    function cleanup() {
      clearTimeout(timer);
      state.listeners.delete(onMessage);
    }

    state.listeners.add(onMessage);
  });
}

async function runSmokeTest({ repoRoot = REPO_ROOT, nodeCommand = process.execPath } = {}) {
  const child = spawn(nodeCommand, ["--no-warnings", path.join(repoRoot, "src", "server.js")], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const state = {
    buffer: Buffer.alloc(0),
    messages: [],
    listeners: new Set(),
    stderr: ""
  };

  child.stdout.on("data", (chunk) => {
    const decoded = decodeMessages(Buffer.concat([state.buffer, chunk]));
    state.buffer = decoded.remaining;
    for (const message of decoded.messages) {
      state.messages.push(message);
      for (const listener of state.listeners) {
        listener(message);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    state.stderr += chunk.toString("utf8");
  });

  try {
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "kendo-docs-smoke", version: "0.1.0" }
      }
    });
    const initialized = await waitForMessage(state, 1);
    if (initialized.error) {
      throw new Error(initialized.error.message);
    }

    send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsResponse = await waitForMessage(state, 2);
    if (toolsResponse.error) {
      throw new Error(toolsResponse.error.message);
    }
    const toolNames = toolsResponse.result.tools.map((tool) => tool.name);
    for (const required of ["search_kendo_docs", "list_kendo_doc_versions"]) {
      if (!toolNames.includes(required)) {
        throw new Error(`Required tool was not listed: ${required}`);
      }
    }

    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_kendo_doc_versions", arguments: {} }
    });
    const versions = toolResult(await waitForMessage(state, 3)) || [];

    let searchResultCount = null;
    const searchable = versions.find((entry) => entry.chunk_count);
    if (searchable) {
      const args = { query: "Grid dataSource", limit: 1 };
      if (searchable.version) {
        args.version = searchable.version;
      }
      send(child, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "search_kendo_docs", arguments: args }
      });
      const searchResults = toolResult(await waitForMessage(state, 4)) || [];
      searchResultCount = searchResults.length;
      if (searchResultCount < 1) {
        throw new Error("Docs corpus was found, but search_kendo_docs returned no results.");
      }
    }

    return { toolNames, versions, searchResultCount };
  } finally {
    child.kill();
  }
}

async function runCli() {
  try {
    const result = await runSmokeTest();
    process.stdout.write(`${summarizeSmokeResult(result)}\n`);
  } catch (error) {
    process.stderr.write(`Smoke test failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  decodeMessages,
  encodeMessage,
  runSmokeTest,
  summarizeSmokeResult
};
