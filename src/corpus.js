const fs = require("node:fs");
const path = require("node:path");

const TOOL_ROOT = path.resolve(__dirname, "..");
const GENERATED_DIR = process.env.KENDO_DOCS_GENERATED_DIR
  ? path.resolve(process.env.KENDO_DOCS_GENERATED_DIR)
  : path.join(TOOL_ROOT, "generated");
const CONFIGURED_DOCS_VERSION = process.env.KENDO_DOCS_VERSION ? process.env.KENDO_DOCS_VERSION.trim() : "";

const FILE_NAMES = {
  chunks: "chunks.jsonl",
  index: "index.json",
  metadata: "metadata.json",
  sqlite: "docs.sqlite"
};

/**
 * Validates and normalizes a Kendo docs version for use as a directory segment.
 */
function safeVersionSegment(version) {
  if (!version || typeof version !== "string") {
    throw new Error("version is required");
  }
  const trimmed = version.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    throw new Error(`Invalid Kendo docs version: ${version}`);
  }
  return trimmed;
}

/**
 * Builds the expected generated corpus file paths for a corpus directory.
 */
function corpusPaths(dir) {
  return {
    dir,
    chunks: path.join(dir, FILE_NAMES.chunks),
    index: path.join(dir, FILE_NAMES.index),
    metadata: path.join(dir, FILE_NAMES.metadata),
    sqlite: path.join(dir, FILE_NAMES.sqlite)
  };
}

/**
 * Resolves an optional generated corpus root against the process default.
 */
function resolveGeneratedDir(generatedDir) {
  return generatedDir ? path.resolve(generatedDir) : GENERATED_DIR;
}

/**
 * Checks whether a directory contains the required generated corpus files.
 */
function hasCorpus(dir) {
  const paths = corpusPaths(dir);
  return fs.existsSync(paths.chunks) && fs.existsSync(paths.index) && fs.existsSync(paths.sqlite);
}

/**
 * Reads optional corpus metadata, returning an empty object when absent.
 */
function readMetadata(paths) {
  if (!fs.existsSync(paths.metadata)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(paths.metadata, "utf8"));
}

/**
 * Lists versioned corpus directories that contain a usable generated corpus.
 */
function versionedCorpusDirs(generatedDir = GENERATED_DIR) {
  const root = resolveGeneratedDir(generatedDir);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ version: entry.name, dir: path.join(root, entry.name) }))
    .filter((entry) => hasCorpus(entry.dir))
    .sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Resolves the effective corpus to use for a requested or configured version.
 */
function resolveCorpus(version) {
  const effectiveVersion = version || CONFIGURED_DOCS_VERSION;
  if (effectiveVersion) {
    const clean = safeVersionSegment(effectiveVersion);
    const dir = path.join(GENERATED_DIR, clean);
    if (!hasCorpus(dir)) {
      throw new Error(`Kendo docs corpus for version ${clean} is not available. Build it first with node src/build-version.js --version ${clean}.`);
    }
    const paths = corpusPaths(dir);
    const metadata = readMetadata(paths);
    return {
      version: clean,
      docs_version: metadata.docs_version || clean,
      is_legacy: false,
      paths,
      metadata
    };
  }

  const legacyDir = GENERATED_DIR;
  const legacyExists = hasCorpus(legacyDir);
  const versioned = versionedCorpusDirs();

  if (versioned.length === 1) {
    const paths = corpusPaths(versioned[0].dir);
    const metadata = readMetadata(paths);
    return {
      version: versioned[0].version,
      docs_version: metadata.docs_version || versioned[0].version,
      is_legacy: false,
      paths,
      metadata
    };
  }

  if (versioned.length > 1) {
    throw new Error(`Multiple Kendo docs corpora are available (${versioned.map((entry) => entry.version).join(", ")}). Pass version or run detect_project_kendo_versions first.`);
  }

  if (legacyExists) {
    const paths = corpusPaths(legacyDir);
    const metadata = readMetadata(paths);
    return {
      version: null,
      docs_version: metadata.docs_version || null,
      is_legacy: true,
      paths,
      metadata
    };
  }

  throw new Error("Generated corpus/index files are missing. Run npm run build:docs first.");
}

/**
 * Returns metadata for a specific versioned corpus when it has been generated.
 */
function getCorpusForVersion(version) {
  if (!version) {
    return null;
  }
  const clean = safeVersionSegment(version);
  const dir = path.join(GENERATED_DIR, clean);
  if (!hasCorpus(dir)) {
    return null;
  }
  const paths = corpusPaths(dir);
  const metadata = readMetadata(paths);
  return {
    version: clean,
    docs_version: metadata.docs_version || clean,
    is_legacy: false,
    paths,
    metadata
  };
}

/**
 * Lists generated Kendo docs corpora with metadata suitable for MCP output.
 */
function listKendoDocVersions({ generatedDir } = {}) {
  const root = resolveGeneratedDir(generatedDir);
  const corpora = [];
  for (const entry of versionedCorpusDirs(root)) {
    const paths = corpusPaths(entry.dir);
    const metadata = readMetadata(paths);
    const index = fs.existsSync(paths.index) ? JSON.parse(fs.readFileSync(paths.index, "utf8")) : {};
    corpora.push({
      version: metadata.docs_version || entry.version,
      path: paths.dir,
      generated_at: metadata.generated_at || index.generated_at || null,
      chunk_count: metadata.chunk_count || index.chunk_count || null,
      targets: Array.isArray(metadata.targets) ? metadata.targets.map((target) => target.render_target) : [],
      source_git_ref: metadata.source_git_ref || null,
      source_git_commit: metadata.source_git_commit || null,
      is_legacy: false
    });
  }

  const legacyPaths = corpusPaths(root);
  if (hasCorpus(root)) {
    const metadata = readMetadata(legacyPaths);
    const index = fs.existsSync(legacyPaths.index) ? JSON.parse(fs.readFileSync(legacyPaths.index, "utf8")) : {};
    corpora.push({
      version: metadata.docs_version || null,
      path: legacyPaths.dir,
      generated_at: metadata.generated_at || index.generated_at || null,
      chunk_count: metadata.chunk_count || index.chunk_count || null,
      targets: Array.isArray(metadata.targets) ? metadata.targets.map((target) => target.render_target) : [],
      source_git_ref: metadata.source_git_ref || null,
      source_git_commit: metadata.source_git_commit || null,
      is_legacy: true
    });
  }

  return corpora.sort((a, b) => {
    if (a.is_legacy !== b.is_legacy) {
      return a.is_legacy ? 1 : -1;
    }
    return String(a.version || "").localeCompare(String(b.version || ""));
  });
}

module.exports = {
  FILE_NAMES,
  GENERATED_DIR,
  TOOL_ROOT,
  corpusPaths,
  getCorpusForVersion,
  hasCorpus,
  listKendoDocVersions,
  resolveCorpus,
  resolveGeneratedDir,
  safeVersionSegment
};
