const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TOOL_ROOT = path.resolve(__dirname, "..");
const KENDO_UI_CORE_REPO_URL = "https://github.com/telerik/kendo-ui-core.git";

/**
 * Resolves a configured source repository path to an absolute candidate path.
 */
function normalizeCandidatePath(value) {
  return path.resolve(value);
}

/**
 * Builds the ordered list of source checkout paths the setup helper should try.
 */
function candidateSourceRepoPaths({ toolRoot = TOOL_ROOT, env = process.env } = {}) {
  const candidates = [];
  if (env.KENDO_DOCS_REPO_ROOT) {
    candidates.push(normalizeCandidatePath(env.KENDO_DOCS_REPO_ROOT));
  }
  candidates.push(path.resolve(toolRoot, "..", "kendo-ui-core"));

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Checks whether a path is an existing git work tree.
 */
function isGitCheckout(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0 && String(result.stdout).trim() === "true";
}

/**
 * Determines whether setup should reuse an existing checkout or clone one.
 */
function planSourceRepoSetup({
  toolRoot = TOOL_ROOT,
  env = process.env,
  exists = fs.existsSync,
  isGitRepo = isGitCheckout
} = {}) {
  const candidates = candidateSourceRepoPaths({ toolRoot, env });
  for (const candidate of candidates) {
    if (!exists(candidate)) {
      continue;
    }
    if (!isGitRepo(candidate)) {
      throw new Error(`Kendo UI Core source path exists but is not a git checkout: ${candidate}`);
    }
    return {
      action: "use-existing",
      repoRoot: candidate
    };
  }

  return {
    action: "clone",
    repoRoot: candidates[0],
    url: KENDO_UI_CORE_REPO_URL
  };
}

/**
 * Clones the Kendo UI Core repository to the requested local path.
 */
function runGitClone(url, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const result = spawnSync("git", ["clone", url, targetPath], {
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`git clone ${url} ${targetPath} failed`);
  }
}

/**
 * Escapes a value as a single-quoted PowerShell string literal.
 */
function formatPowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Ensures a usable Kendo UI Core source checkout exists and returns its path.
 */
function ensureKendoSourceRepo(options = {}) {
  const plan = planSourceRepoSetup(options);
  if (plan.action === "use-existing") {
    return plan.repoRoot;
  }

  process.stdout.write(`Kendo UI Core checkout not found. Cloning ${plan.url} to ${plan.repoRoot}...\n`);
  runGitClone(plan.url, plan.repoRoot);
  return plan.repoRoot;
}

/**
 * Runs the source checkout setup CLI and prints the resolved checkout path.
 */
function runCli() {
  const repoRoot = ensureKendoSourceRepo();
  process.stdout.write(`Kendo UI Core source checkout ready at ${repoRoot}\n`);
  process.stdout.write(`PowerShell: $env:KENDO_DOCS_REPO_ROOT = ${formatPowerShellString(repoRoot)}\n`);
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  KENDO_UI_CORE_REPO_URL,
  candidateSourceRepoPaths,
  ensureKendoSourceRepo,
  formatPowerShellString,
  isGitCheckout,
  planSourceRepoSetup,
  runCli
};
