const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { TOOL_ROOT, safeVersionSegment } = require("./corpus");

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || TOOL_ROOT,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout || ""}${result.stderr || ""}`.trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? (result.stdout || "").trim() : "";
}

function ensureTagRef(sourceRepo, version) {
  const candidates = [`refs/tags/${version}`, version];
  for (const candidate of candidates) {
    try {
      run("git", ["-C", sourceRepo, "rev-parse", "--verify", candidate], { capture: true });
      return candidate;
    } catch {
      // Try the next spelling.
    }
  }
  throw new Error(`Could not find Kendo UI Core git tag/ref for version ${version} in ${sourceRepo}.`);
}

function resolveGitPath(repoPath, value) {
  return path.resolve(repoPath, value).toLowerCase();
}

function ensureWorktree(sourceRepo, version, gitRef) {
  const cacheRoot = path.join(TOOL_ROOT, ".cache", "kendo-worktrees");
  const worktreePath = path.join(cacheRoot, version);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const sourceCommonDir = resolveGitPath(sourceRepo, run("git", ["-C", sourceRepo, "rev-parse", "--git-common-dir"], { capture: true }));
  const expectedCommit = run("git", ["-C", sourceRepo, "rev-parse", `${gitRef}^{commit}`], { capture: true });

  if (fs.existsSync(path.join(worktreePath, ".git"))) {
    const cachedCommonDir = resolveGitPath(worktreePath, run("git", ["-C", worktreePath, "rev-parse", "--git-common-dir"], { capture: true }));
    if (cachedCommonDir !== sourceCommonDir) {
      throw new Error(`Cached worktree ${worktreePath} belongs to a different git repository. Remove it before rebuilding ${version}.`);
    }
    const cachedCommit = run("git", ["-C", worktreePath, "rev-parse", "HEAD"], { capture: true });
    if (cachedCommit !== expectedCommit) {
      run("git", ["-C", sourceRepo, "worktree", "remove", "--force", worktreePath]);
      run("git", ["-C", sourceRepo, "worktree", "add", "--detach", worktreePath, gitRef]);
    }
    return worktreePath;
  }

  if (fs.existsSync(worktreePath)) {
    throw new Error(`Cache path exists but is not a git worktree: ${worktreePath}`);
  }

  run("git", ["-C", sourceRepo, "worktree", "add", "--detach", worktreePath, gitRef]);
  return worktreePath;
}

function main() {
  const sourceRepo = argValue("--source-repo");
  const versionArg = argValue("--version");
  if (!sourceRepo) {
    throw new Error("--source-repo is required");
  }
  if (!versionArg) {
    throw new Error("--version is required");
  }

  const version = safeVersionSegment(versionArg);
  const sourceRepoPath = path.resolve(sourceRepo);
  const gitRef = ensureTagRef(sourceRepoPath, version);
  const worktreePath = ensureWorktree(sourceRepoPath, version, gitRef);
  const commit = run("git", ["-C", worktreePath, "rev-parse", "HEAD"], { capture: true });

  run(process.execPath, [
    path.join(TOOL_ROOT, "src", "extract.js"),
    "--repo-root",
    worktreePath,
    "--version",
    version,
    "--source-git-ref",
    gitRef,
    "--source-git-commit",
    commit
  ]);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
