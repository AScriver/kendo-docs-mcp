const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildCodexConfig,
  buildConfigInstructions,
  discoverSetupCorpora,
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
  generatedDir: "D:/Shared/kendo-generated",
  kendoVersion: "2025.3.812"
});

assert.match(withGeneratedOverride, /\[mcp_servers\.kendo-docs\.env\]\nKENDO_DOCS_GENERATED_DIR = "D:\/Shared\/kendo-generated"\nKENDO_DOCS_VERSION = "2025\.3\.812"\n$/);

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

const generatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kendo-generated-"));
try {
  const versionDir = path.join(generatedRoot, "2025.3.812");
  fs.mkdirSync(versionDir);
  fs.writeFileSync(path.join(versionDir, "chunks.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(versionDir, "index.json"), JSON.stringify({ chunk_count: 1 }), "utf8");
  fs.writeFileSync(path.join(versionDir, "docs.sqlite"), "", "utf8");
  fs.writeFileSync(path.join(versionDir, "metadata.json"), JSON.stringify({ docs_version: "2025.3.812" }), "utf8");

  const discovered = discoverSetupCorpora({ generatedDir: generatedRoot });
  assert.deepEqual(discovered, {
    generatedVersions: ["2025.3.812"],
    legacyCorpusAvailable: false
  });

  const setupOutput = childProcess.execFileSync(process.execPath, [
    path.join(__dirname, "codex-config.js"),
    "--generated-dir",
    generatedRoot
  ], { encoding: "utf8" });
  assert.match(setupOutput, /Generated docs corpora found: 2025\.3\.812\./);
  assert.doesNotMatch(setupOutput, /No generated docs corpus was found/);
} finally {
  fs.rmSync(generatedRoot, { recursive: true, force: true });
}

process.stdout.write("Codex config tests passed.\n");
