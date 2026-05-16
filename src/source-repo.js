const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TOOL_ROOT = path.resolve(__dirname, "..");
const KENDO_UI_CORE_REPO_URL = "https://github.com/telerik/kendo-ui-core.git";

function normalizeCandidatePath(value) {
  return path.resolve(value);
}

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

function isGitCheckout(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.status === 0 && String(result.stdout).trim() === "true";
}

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

function formatPowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ensureKendoSourceRepo(options = {}) {
  const plan = planSourceRepoSetup(options);
  if (plan.action === "use-existing") {
    return plan.repoRoot;
  }

  process.stdout.write(`Kendo UI Core checkout not found. Cloning ${plan.url} to ${plan.repoRoot}...\n`);
  runGitClone(plan.url, plan.repoRoot);
  return plan.repoRoot;
}

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
