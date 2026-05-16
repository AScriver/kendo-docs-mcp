const fs = require("node:fs");
const path = require("node:path");
const { listKendoDocVersions } = require("./corpus");

const MIN_NODE_VERSION = "22.5.0";

function normalizeConfigPath(value) {
  return path.resolve(value).replace(/\\/g, "/");
}

function formatTomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function versionParts(version) {
  return String(version)
    .split(".")
    .map((part) => Number(part.replace(/^v/i, "")) || 0);
}

function isNodeVersionSupported(version, minimum = MIN_NODE_VERSION) {
  const actual = versionParts(version);
  const required = versionParts(minimum);
  for (let index = 0; index < Math.max(actual.length, required.length); index += 1) {
    const left = actual[index] || 0;
    const right = required[index] || 0;
    if (left > right) {
      return true;
    }
    if (left < right) {
      return false;
    }
  }
  return true;
}

function buildCodexConfig({ repoRoot, nodeCommand = "node", nodeArgs = ["--no-warnings"], generatedDir } = {}) {
  const root = normalizeConfigPath(repoRoot || path.resolve(__dirname, ".."));
  const args = [...nodeArgs, `${root}/src/server.js`].map((arg) => formatTomlString(arg)).join(", ");
  const lines = [
    "[mcp_servers.kendo-docs]",
    `command = ${formatTomlString(nodeCommand)}`,
    `args = [${args}]`,
    `cwd = ${formatTomlString(root)}`
  ];

  if (generatedDir) {
    lines.push("", "[mcp_servers.kendo-docs.env]", `KENDO_DOCS_GENERATED_DIR = ${formatTomlString(normalizeConfigPath(generatedDir))}`);
  }

  return `${lines.join("\n")}\n`;
}

function resolveSetupStatus({
  nodeVersion = process.versions.node,
  generatedVersions = [],
  legacyCorpusAvailable = false
} = {}) {
  const warnings = [];
  if (!isNodeVersionSupported(nodeVersion)) {
    warnings.push(`Node ${MIN_NODE_VERSION} or newer is required. Current Node version is ${nodeVersion}.`);
  }
  if (!legacyCorpusAvailable && generatedVersions.length === 0) {
    warnings.push("No generated docs corpus was found. Build one before expecting lookup tools to return docs.");
  }
  return {
    ready: warnings.length === 0,
    warnings
  };
}

function buildConfigInstructions({
  repoRoot = path.resolve(__dirname, ".."),
  nodeCommand = "node",
  generatedDir,
  generatedVersions = [],
  legacyCorpusAvailable = false,
  nodeVersion = process.versions.node
} = {}) {
  const config = buildCodexConfig({ repoRoot, nodeCommand, generatedDir });
  const status = resolveSetupStatus({ nodeVersion, generatedVersions, legacyCorpusAvailable });
  const lines = [
    "Copy this block into your Codex config.toml, then restart Codex:",
    "",
    "```toml",
    config.trimEnd(),
    "```",
    "",
    "After restart, point Codex at this server by asking it to use the kendo-docs MCP tools.",
    "Run npm run smoke from this repo to verify the stdio MCP protocol and docs lookup path."
  ];

  if (generatedVersions.length) {
    lines.push("", `Generated docs corpora found: ${generatedVersions.join(", ")}.`);
  } else if (legacyCorpusAvailable) {
    lines.push("", "Legacy generated docs corpus found in generated/.");
  }

  if (status.warnings.length) {
    lines.push("", "Warnings:");
    for (const warning of status.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function getArgValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function runCli(args = process.argv.slice(2)) {
  const repoRoot = path.resolve(getArgValue(args, "--repo-root") || path.resolve(__dirname, ".."));
  const nodeCommand = getArgValue(args, "--node-command") || "node";
  const generatedDir = getArgValue(args, "--generated-dir") || null;
  const corpora = listKendoDocVersions();
  const generatedVersions = corpora
    .filter((entry) => !entry.is_legacy && entry.version)
    .map((entry) => entry.version);
  const legacyCorpusAvailable = corpora.some((entry) => entry.is_legacy);

  process.stdout.write(buildConfigInstructions({
    repoRoot,
    nodeCommand,
    generatedDir,
    generatedVersions,
    legacyCorpusAvailable
  }));

  const localConfig = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex", "config.toml");
  if (localConfig && fs.existsSync(localConfig)) {
    process.stdout.write(`\nLocal Codex config detected at ${localConfig}.\n`);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  buildCodexConfig,
  buildConfigInstructions,
  formatTomlString,
  isNodeVersionSupported,
  resolveSetupStatus,
  runCli
};
