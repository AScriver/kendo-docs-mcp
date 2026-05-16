const assert = require("node:assert/strict");
const path = require("node:path");
const {
  KENDO_UI_CORE_REPO_URL,
  candidateSourceRepoPaths,
  formatPowerShellString,
  planSourceRepoSetup
} = require("./source-repo");

const toolRoot = path.resolve("C:/Users/Scott/Code/kendo-docs-mcp");
const siblingRepo = path.resolve("C:/Users/Scott/Code/kendo-ui-core");

assert.deepEqual(candidateSourceRepoPaths({
  toolRoot,
  env: {}
}), [siblingRepo]);

const configuredRepo = path.resolve("D:/Repos/kendo-ui-core");
assert.deepEqual(candidateSourceRepoPaths({
  toolRoot,
  env: { KENDO_DOCS_REPO_ROOT: configuredRepo }
}), [configuredRepo, siblingRepo]);

const existingPlan = planSourceRepoSetup({
  toolRoot,
  env: {},
  exists: (candidate) => candidate === siblingRepo,
  isGitRepo: (candidate) => candidate === siblingRepo
});

assert.deepEqual(existingPlan, {
  action: "use-existing",
  repoRoot: siblingRepo
});

const clonePlan = planSourceRepoSetup({
  toolRoot,
  env: {},
  exists: () => false,
  isGitRepo: () => false
});

assert.deepEqual(clonePlan, {
  action: "clone",
  repoRoot: siblingRepo,
  url: KENDO_UI_CORE_REPO_URL
});

assert.throws(
  () => planSourceRepoSetup({
    toolRoot,
    env: { KENDO_DOCS_REPO_ROOT: configuredRepo },
    exists: (candidate) => candidate === configuredRepo,
    isGitRepo: () => false
  }),
  /exists but is not a git checkout/
);

assert.equal(formatPowerShellString("C:\\Users\\Scott\\Code\\kendo-ui-core"), "'C:\\Users\\Scott\\Code\\kendo-ui-core'");
assert.equal(formatPowerShellString("C:\\Scott's Code\\kendo-ui-core"), "'C:\\Scott''s Code\\kendo-ui-core'");

process.stdout.write("Source repo setup tests passed.\n");
