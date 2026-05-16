const { callTool } = require("./docs");

const tools = [
  {
    name: "search_kendo_docs",
    description: "Search source-linked Kendo UI documentation chunks.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        component: { type: "string" },
        source_type: { type: "string", enum: ["api", "guide", "example", "overview", "unknown"] },
        member_type: { type: "string", enum: ["configuration", "method", "event", "field", "property", "overview", "example"] },
        render_target: { type: "string", enum: ["jquery", "aspnet-core", "aspnet-mvc"] },
        limit: { type: "number" }
      },
      required: ["query"]
    }
  },
  {
    name: "get_kendo_doc",
    description: "Get a full documentation chunk by deterministic id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        include_neighbors: { type: "boolean" }
      },
      required: ["id"]
    }
  },
  {
    name: "get_kendo_api_member",
    description: "Look up an exact or best matching Kendo API member by component and member name.",
    inputSchema: {
      type: "object",
      properties: {
        component: { type: "string" },
        member_name: { type: "string" },
        member_type: { type: "string", enum: ["configuration", "method", "event", "field", "property", "overview", "example"] },
        render_target: { type: "string", enum: ["jquery", "aspnet-core", "aspnet-mvc"] }
      },
      required: ["component", "member_name"]
    }
  },
  {
    name: "list_kendo_components",
    description: "List Kendo components/widgets/modules discovered from the local docs corpus.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        render_target: { type: "string", enum: ["jquery", "aspnet-core", "aspnet-mvc"] }
      }
    }
  },
  {
    name: "find_kendo_examples",
    description: "Find documentation chunks that contain relevant code examples.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        component: { type: "string" },
        render_target: { type: "string", enum: ["jquery", "aspnet-core", "aspnet-mvc"] },
        limit: { type: "number" }
      },
      required: ["query"]
    }
  }
];

function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function success(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function failure(id, error) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: error && error.message ? error.message : String(error)
    }
  });
}

function handle(message) {
  if (message.method === "initialize") {
    success(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "kendo-docs-mcp", version: "0.1.0" }
    });
    return;
  }

  if (message.method === "tools/list") {
    success(message.id, { tools });
    return;
  }

  if (message.method === "tools/call") {
    try {
      const name = message.params && message.params.name;
      const args = (message.params && message.params.arguments) || {};
      const result = callTool(name, args);
      success(message.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: { result }
      });
    } catch (error) {
      failure(message.id, error);
    }
    return;
  }

  if (message.id !== undefined && message.id !== null) {
    failure(message.id, new Error(`Unsupported method: ${message.method}`));
  }
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      break;
    }
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      break;
    }
    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);
    try {
      handle(JSON.parse(body));
    } catch (error) {
      failure(null, error);
    }
  }
});

process.stdin.resume();
