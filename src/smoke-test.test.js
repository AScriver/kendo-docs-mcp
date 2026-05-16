const assert = require("node:assert/strict");
const {
  decodeMessages,
  encodeMessage,
  summarizeSmokeResult
} = require("./smoke-test");

const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
assert.match(encoded.toString("utf8"), /^Content-Length: \d+\r\n\r\n/);

const chunks = [
  encoded.slice(0, 10),
  Buffer.concat([
    encoded.slice(10),
    encodeMessage({ jsonrpc: "2.0", id: 2, result: { tools: [] } })
  ])
];

let pending = Buffer.alloc(0);
let messages = [];
for (const chunk of chunks) {
  const decoded = decodeMessages(Buffer.concat([pending, chunk]));
  pending = decoded.remaining;
  messages = messages.concat(decoded.messages);
}

assert.deepEqual(messages.map((message) => message.id), [1, 2]);
assert.equal(pending.length, 0);

assert.equal(
  summarizeSmokeResult({
    toolNames: ["list_kendo_doc_versions", "search_kendo_docs"],
    versions: [{ version: "2025.3.812", chunk_count: 100 }],
    searchResultCount: 1
  }),
  "MCP protocol responded, 2 tools were listed, 1 docs corpus was found, and a search returned 1 result."
);

assert.equal(
  summarizeSmokeResult({
    toolNames: ["list_kendo_doc_versions"],
    versions: [],
    searchResultCount: null
  }),
  "MCP protocol responded and 1 tool was listed. No docs corpus was found, so search was skipped."
);

process.stdout.write("Smoke test helper tests passed.\n");
