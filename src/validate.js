const { callTool, getKendoApiMember, getKendoDoc, searchKendoDocs } = require("./docs");
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

function bestResultForQuery(query) {
  if (/^Grid dataSource/.test(query)) {
    return getKendoApiMember({ component: "Grid", member_name: "dataSource", member_type: "configuration" })[0];
  }
  if (/^Grid change/.test(query)) {
    return getKendoApiMember({ component: "Grid", member_name: "change", member_type: "event" })[0];
  }
  if (/^Upload async/.test(query)) {
    return getKendoApiMember({ component: "Upload", member_name: "async.saveUrl", member_type: "configuration" })[0];
  }
  if (/^DataSource schema/.test(query)) {
    return getKendoApiMember({ component: "DataSource", member_name: "schema.model.id", member_type: "configuration" })[0];
  }
  if (/^Window refresh/.test(query)) {
    return getKendoApiMember({ component: "Window", member_name: "refresh", member_type: "method" })[0];
  }
  if (/^ObservableObject set/.test(query)) {
    return getKendoApiMember({ component: "ObservableObject", member_name: "set", member_type: "method" })[0];
  }
  return searchKendoDocs({ query, limit: 1 })[0];
}

function excerpt(text) {
  return (text || "").replace(/\s+/g, " ").trim().slice(0, 280);
}

let failures = 0;

const tools = callTool("list_kendo_components", { query: "Grid" });
if (!tools.some((component) => component.name === "Grid")) {
  failures += 1;
  process.stdout.write("Component validation failed: Grid was not discovered.\n");
}

for (const check of checks) {
  const top = bestResultForQuery(check.query);
  const ok = Boolean(top && check.expected(top));
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

if (failures > 0) {
  process.stdout.write(`\nValidation failed with ${failures} failing check(s).\n`);
  process.exit(1);
}

process.stdout.write("\nValidation passed.\n");
