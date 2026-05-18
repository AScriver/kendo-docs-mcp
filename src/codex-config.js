const fs = require("node:fs");
const path = require("node:path");
const { listKendoDocVersions } = require("./corpus");

const MIN_NODE_VERSION = "22.5.0";

/**
 * Converts a filesystem path to the forward-slash form used in Codex config.
 */
function normalizeConfigPath(value) {
  return path.resolve(value).replace(/\\/g, "/");
}

/**
 * Escapes a JavaScript value as a double-quoted TOML string literal.
 */
function formatTomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Splits a Node version string into comparable numeric parts.
 */
function versionParts(version) {
  return String(version)
    .split(".")
    .map((part) => Number(part.replace(/^v/i, "")) || 0);
}

/**
 * Checks whether a Node version satisfies this server's minimum requirement.
 */
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

/**
 * Builds the TOML block that registers this server in Codex.
 */
function buildCodexConfig({ repoRoot, nodeCommand = "node", nodeArgs = ["--no-warnings"], generatedDir, kendoVersion } = {}) {
  const root = normalizeConfigPath(repoRoot || path.resolve(__dirname, ".."));
  const args = [...nodeArgs, `${root}/src/server.js`].map((arg) => formatTomlString(arg)).join(", ");
  const lines = [
    "[mcp_servers.kendo-docs]",
    `command = ${formatTomlString(nodeCommand)}`,
    `args = [${args}]`,
    `cwd = ${formatTomlString(root)}`
  ];

  const envLines = [];
  if (generatedDir) {
    envLines.push(`KENDO_DOCS_GENERATED_DIR = ${formatTomlString(normalizeConfigPath(generatedDir))}`);
  }
  if (kendoVersion) {
    envLines.push(`KENDO_DOCS_VERSION = ${formatTomlString(kendoVersion.trim())}`);
  }
  if (envLines.length) {
    lines.push("", "[mcp_servers.kendo-docs.env]", ...envLines);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Summarizes whether the local runtime and corpus state are ready for use.
 */
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

/**
 * Formats the user-facing setup instructions and config block.
 */
function buildConfigInstructions({
  repoRoot = path.resolve(__dirname, ".."),
  nodeCommand = "node",
  generatedDir,
  kendoVersion,
  generatedVersions = [],
  legacyCorpusAvailable = false,
  nodeVersion = process.versions.node
} = {}) {
  const config = buildCodexConfig({ repoRoot, nodeCommand, generatedDir, kendoVersion });
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

/**
 * Reads a named command-line option from either split or equals syntax.
 */
function getArgValue(args, name) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

/**
 * Discovers generated corpora to report during Codex config setup.
 */
function discoverSetupCorpora({ generatedDir } = {}) {
  const corpora = listKendoDocVersions({ generatedDir });
  return {
    generatedVersions: corpora
      .filter((entry) => !entry.is_legacy && entry.version)
      .map((entry) => entry.version),
    legacyCorpusAvailable: corpora.some((entry) => entry.is_legacy)
  };
}

/**
 * Runs the Codex config helper CLI and prints setup guidance.
 */
function runCli(args = process.argv.slice(2)) {
  const repoRoot = path.resolve(getArgValue(args, "--repo-root") || path.resolve(__dirname, ".."));
  const nodeCommand = getArgValue(args, "--node-command") || "node";
  const generatedDir = getArgValue(args, "--generated-dir") || null;
  const kendoVersion = getArgValue(args, "--kendo-version") || null;
  const { generatedVersions, legacyCorpusAvailable } = discoverSetupCorpora({ generatedDir });

  process.stdout.write(buildConfigInstructions({
    repoRoot,
    nodeCommand,
    generatedDir,
    kendoVersion,
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
  discoverSetupCorpora,
  formatTomlString,
  isNodeVersionSupported,
  resolveSetupStatus,
  runCli
};
