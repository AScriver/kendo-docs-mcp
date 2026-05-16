const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEST_VERSION = "2025.3.812";
const DEFAULT_GENERATED_DIR = path.join(__dirname, "..", "generated");

function linkOrCopy(source, destination) {
  try {
    fs.linkSync(source, destination);
  } catch {
    fs.copyFileSync(source, destination);
  }
}

function prepareValidationGeneratedRoot() {
  const tempGeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), "kendo-docs-mcp-generated-"));
  for (const name of ["chunks.jsonl", "index.json", "metadata.json", "docs.sqlite"]) {
    const source = path.join(DEFAULT_GENERATED_DIR, name);
    if (!fs.existsSync(source)) {
      throw new Error("Generated corpus/index files are missing. Run npm run build:docs first.");
    }
    if (name === "index.json" || name === "metadata.json") {
      fs.copyFileSync(source, path.join(tempGeneratedDir, name));
    } else {
      linkOrCopy(source, path.join(tempGeneratedDir, name));
    }
  }

  const versionDir = path.join(tempGeneratedDir, TEST_VERSION);
  fs.mkdirSync(versionDir, { recursive: true });
  linkOrCopy(path.join(DEFAULT_GENERATED_DIR, "chunks.jsonl"), path.join(versionDir, "chunks.jsonl"));
  linkOrCopy(path.join(DEFAULT_GENERATED_DIR, "docs.sqlite"), path.join(versionDir, "docs.sqlite"));

  const metadataPath = path.join(versionDir, "metadata.json");
  const metadata = JSON.parse(fs.readFileSync(path.join(DEFAULT_GENERATED_DIR, "metadata.json"), "utf8"));
  metadata.docs_version = TEST_VERSION;
  metadata.source_git_ref = `refs/tags/${TEST_VERSION}`;
  metadata.source_git_commit = metadata.source_git_commit || "validation-fixture";
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const indexPath = path.join(versionDir, "index.json");
  const index = JSON.parse(fs.readFileSync(path.join(DEFAULT_GENERATED_DIR, "index.json"), "utf8"));
  index.docs_version = TEST_VERSION;
  index.source_git_ref = `refs/tags/${TEST_VERSION}`;
  index.source_git_commit = index.source_git_commit || "validation-fixture";
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  return tempGeneratedDir;
}

const validationGeneratedDir = prepareValidationGeneratedRoot();
process.env.KENDO_DOCS_GENERATED_DIR = validationGeneratedDir;
process.on("exit", () => {
  fs.rmSync(validationGeneratedDir, { recursive: true, force: true });
});

const { callTool, getKendoApiMember, searchKendoDocs } = require("./docs");
const { CHUNKS_PATH, readJsonLines } = require("./lib");

const checks = [
  {
    query: "Grid dataSource configuration",
    expected: (result) => result.component === "Grid" && result.member_name === "dataSource"
  },
  {
    query: "Grid change event",
    expected: (result) => result.component === "Grid" && result.member_name === "change" && result.member_type === "event"
  },
  {
    query: "Upload async saveUrl",
    expected: (result) => result.component === "Upload" && result.member_name === "async.saveUrl"
  },
  {
    query: "DataSource schema model id",
    expected: (result) => result.component === "DataSource" && result.member_name === "schema.model"
  },
  {
    query: "Window refresh method",
    expected: (result) => result.component === "Window" && result.member_name === "refresh" && result.member_type === "method"
  },
  {
    query: "Kendo template syntax",
    expected: (result) =>
      /templates/i.test(result.title) || result.source_path.includes("framework/templates")
  },
  {
    query: "ObservableObject set method",
    expected: (result) => result.component === "ObservableObject" && result.member_name === "set"
  }
];

const renderChecks = [
  {
    name: "jQuery Grid overview renders site.product",
    find: () => {
      return readJsonLines(CHUNKS_PATH).find(
        (chunk) =>
          chunk.source_path === "docs/controls/grid/overview.md" &&
          chunk.render_target === "jquery" &&
          chunk.text.includes("Kendo UI for jQuery Grid Overview")
      );
    },
    expectedText: (result) =>
      result &&
      result.text &&
      result.text.includes("# Kendo UI for jQuery Grid Overview") &&
      !result.text.includes("{{") &&
      !result.text.includes("{%") &&
      result.text_raw === undefined
  }
];

function bestResultForQuery(query, version) {
  if (/^Grid dataSource/.test(query)) {
    return getKendoApiMember({ component: "Grid", member_name: "dataSource", member_type: "configuration", version })[0];
  }
  if (/^Grid change/.test(query)) {
    return getKendoApiMember({ component: "Grid", member_name: "change", member_type: "event", version })[0];
  }
  if (/^Upload async/.test(query)) {
    return getKendoApiMember({ component: "Upload", member_name: "async.saveUrl", member_type: "configuration", version })[0];
  }
  if (/^DataSource schema/.test(query)) {
    return getKendoApiMember({ component: "DataSource", member_name: "schema.model.id", member_type: "configuration", version })[0];
  }
  if (/^Window refresh/.test(query)) {
    return getKendoApiMember({ component: "Window", member_name: "refresh", member_type: "method", version })[0];
  }
  if (/^ObservableObject set/.test(query)) {
    return getKendoApiMember({ component: "ObservableObject", member_name: "set", member_type: "method", version })[0];
  }
  return searchKendoDocs({ query, version, limit: 1 })[0];
}

function excerpt(text) {
  return (text || "").replace(/\s+/g, " ").trim().slice(0, 280);
}

let failures = 0;

const legacyTools = callTool("list_kendo_components", { query: "Grid", version: null });
if (!legacyTools.some((component) => component.name === "Grid")) {
  failures += 1;
  process.stdout.write("Legacy component validation failed: Grid was not discovered.\n");
}

const tools = callTool("list_kendo_components", { query: "Grid", version: TEST_VERSION });
if (!tools.some((component) => component.name === "Grid")) {
  failures += 1;
  process.stdout.write("Versioned component validation failed: Grid was not discovered.\n");
}
if (!tools.every((component) => component.docs_version === TEST_VERSION)) {
  failures += 1;
  process.stdout.write("Versioned component validation failed: docs_version was not included.\n");
}

for (const check of checks) {
  const top = bestResultForQuery(check.query, TEST_VERSION);
  const ok = Boolean(top && top.docs_version === TEST_VERSION && top.source_git_ref && top.source_git_commit && check.expected(top));
  if (!ok) {
    failures += 1;
  }
  process.stdout.write(`\nQuery: ${check.query}\n`);
  process.stdout.write(`Top result title: ${top ? top.title : "(none)"}\n`);
  process.stdout.write(`Component: ${top ? top.component : "(none)"}\n`);
  process.stdout.write(`Member name: ${top && top.member_name ? top.member_name : "(none)"}\n`);
  process.stdout.write(`Source path: ${top ? top.source_path : "(none)"}\n`);
  process.stdout.write(`Excerpt: ${top ? excerpt(top.text || top.excerpt) : "(none)"}\n`);
  process.stdout.write(`Appears correct: ${ok ? "yes" : "no"}\n`);
}

for (const check of renderChecks) {
  const result = check.find();
  const ok = Boolean(result && check.expectedText(result));
  if (!ok) {
    failures += 1;
  }
  process.stdout.write(`\nRender check: ${check.name}\n`);
  process.stdout.write(`Source path: ${result ? result.source_path : "(none)"}\n`);
  process.stdout.write(`Render target: ${result ? result.render_target : "(none)"}\n`);
  process.stdout.write(`Excerpt: ${result ? excerpt(result.text || result.excerpt) : "(none)"}\n`);
  process.stdout.write(`Appears correct: ${ok ? "yes" : "no"}\n`);
}

const versionList = callTool("list_kendo_doc_versions", {});
if (!versionList.some((entry) => entry.version === TEST_VERSION && entry.chunk_count > 0)) {
  failures += 1;
  process.stdout.write("Version listing validation failed: generated version metadata was not returned.\n");
}

function writeFixture(root, relativePath, text) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
}

function detectFixture(name, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kendo-docs-mcp-${name}-`));
  for (const [relativePath, text] of Object.entries(files)) {
    writeFixture(root, relativePath, text);
  }
  return callTool("detect_project_kendo_versions", { project_root: root });
}

const matching = detectFixture("matching", {
  "App.csproj": `<Project><ItemGroup><PackageReference Include="Telerik.UI.for.AspNet.Core" Version="${TEST_VERSION}" /></ItemGroup></Project>`,
  "Views/Shared/_Layout.cshtml": `<!-- https://kendo.cdn.telerik.com/2024.1.130/js/kendo.all.min.js --><link href="https://kendo.cdn.telerik.com/themes/10.2.0/default/default-main.css" rel="stylesheet" /><div data-url="https://kendo.cdn.telerik.com/2023.1.117/js/kendo.all.min.js"></div><script src="https://kendo.cdn.telerik.com/${TEST_VERSION}/js/kendo.all.min.js"></script>`
});
if (matching.recommended_docs_version !== TEST_VERSION || matching.warnings.length !== 0 || matching.kendo_cdn_versions.length !== 1 || matching.kendo_cdn_versions[0] !== TEST_VERSION) {
  failures += 1;
  process.stdout.write("Detection validation failed: matching package/CDN did not recommend cleanly.\n");
}

const mismatch = detectFixture("mismatch", {
  "App.csproj": `<Project><ItemGroup><PackageReference Include="Telerik.UI.for.AspNet.Core" Version="${TEST_VERSION}" /></ItemGroup></Project>`,
  "Views/Shared/_Layout.cshtml": `<script src="https://kendo.cdn.telerik.com/2024.4.1112/js/kendo.all.min.js"></script>`
});
if (mismatch.recommended_docs_version !== TEST_VERSION || !mismatch.warnings.some((warning) => /does not match/.test(warning))) {
  failures += 1;
  process.stdout.write("Detection validation failed: package/CDN mismatch did not warn and prefer package.\n");
}

const cdnOnly = detectFixture("cdn-only", {
  "Views/Shared/_Layout.cshtml": `<script src="https://kendo.cdn.telerik.com/${TEST_VERSION}/js/kendo.all.min.js"></script>`
});
if (cdnOnly.recommended_docs_version !== TEST_VERSION) {
  failures += 1;
  process.stdout.write("Detection validation failed: CDN-only project did not fall back to CDN version.\n");
}

const htmlOnly = detectFixture("html-only", {
  "index.html": `<script src="https://kendo.cdn.telerik.com/${TEST_VERSION}/js/kendo.all.min.js"></script>`
});
if (htmlOnly.recommended_docs_version !== null || htmlOnly.kendo_cdn_versions.length !== 0) {
  failures += 1;
  process.stdout.write("Detection validation failed: non-Razor HTML file was treated as a Razor script source.\n");
}

const missing = detectFixture("missing", {
  "App.csproj": `<Project></Project>`
});
if (missing.recommended_docs_version !== null || !missing.warnings.some((warning) => /No Telerik\.UI\.for\.AspNet\.Core/.test(warning))) {
  failures += 1;
  process.stdout.write("Detection validation failed: missing project did not return a clear warning.\n");
}

if (failures > 0) {
  process.stdout.write(`\nValidation failed with ${failures} failing check(s).\n`);
  process.exit(1);
}

process.stdout.write("\nValidation passed.\n");
