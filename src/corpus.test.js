const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function writeCorpus(root, version) {
  const dir = path.join(root, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "chunks.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ chunk_count: 1 }), "utf8");
  fs.writeFileSync(path.join(dir, "docs.sqlite"), "", "utf8");
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ docs_version: version }), "utf8");
}

const generatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kendo-corpus-"));
try {
  writeCorpus(generatedRoot, "2024.4.1112");
  writeCorpus(generatedRoot, "2025.3.812");

  const output = childProcess.execFileSync(process.execPath, [
    "-e",
    `const assert = require("node:assert/strict");
const { resolveCorpus } = require(${JSON.stringify(path.join(__dirname, "corpus"))});
assert.equal(resolveCorpus().version, "2025.3.812");
assert.equal(resolveCorpus("2024.4.1112").version, "2024.4.1112");
process.stdout.write("ok");`
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      KENDO_DOCS_GENERATED_DIR: generatedRoot,
      KENDO_DOCS_VERSION: "2025.3.812"
    }
  });

  assert.equal(output, "ok");
} finally {
  fs.rmSync(generatedRoot, { recursive: true, force: true });
}

process.stdout.write("Corpus tests passed.\n");
