const assert = require("node:assert/strict");
const path = require("node:path");
const {
  buildCodexConfig,
  buildConfigInstructions,
  formatTomlString,
  resolveSetupStatus
} = require("./codex-config");

const repoRoot = path.resolve("C:/Work/kendo-docs-mcp");
const nodeCommand = "C:/Program Files/nodejs/node.exe";

const config = buildCodexConfig({ repoRoot, nodeCommand });

assert.equal(config, `[mcp_servers.kendo-docs]
command = "C:/Program Files/nodejs/node.exe"
args = ["--no-warnings", "C:/Work/kendo-docs-mcp/src/server.js"]
cwd = "C:/Work/kendo-docs-mcp"
`);

assert.equal(formatTomlString('C:\\Path With "Quotes"\\tool'), '"C:\\\\Path With \\"Quotes\\"\\\\tool"');

const withGeneratedOverride = buildCodexConfig({
  repoRoot,
  nodeCommand: "node",
  generatedDir: "D:/Shared/kendo-generated"
});

assert.match(withGeneratedOverride, /\[mcp_servers\.kendo-docs\.env\]\nKENDO_DOCS_GENERATED_DIR = "D:\/Shared\/kendo-generated"\n$/);

const missingCorpus = resolveSetupStatus({
  nodeVersion: "22.5.0",
  generatedVersions: [],
  legacyCorpusAvailable: false
});

assert.equal(missingCorpus.ready, false);
assert.deepEqual(missingCorpus.warnings, [
  "No generated docs corpus was found. Build one before expecting lookup tools to return docs."
]);

const oldNode = resolveSetupStatus({
  nodeVersion: "20.11.0",
  generatedVersions: ["2025.3.812"],
  legacyCorpusAvailable: false
});

assert.equal(oldNode.ready, false);
assert.match(oldNode.warnings[0], /Node 22\.5\.0 or newer/);

const instructions = buildConfigInstructions({
  repoRoot,
  nodeCommand: "node",
  generatedVersions: ["2025.3.812"],
  legacyCorpusAvailable: false
});

assert.match(instructions, /Copy this block into/);
assert.match(instructions, /2025\.3\.812/);
assert.match(instructions, /npm run smoke/);

process.stdout.write("Codex config tests passed.\n");
