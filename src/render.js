const fs = require("node:fs");
const path = require("node:path");
const { parseFrontMatter, slugify } = require("./lib");

/**
 * Parses a simple YAML scalar used by the source docs configuration files.
 */
function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Reads top-level and liquid configuration values from a Jekyll YAML file.
 */
function parseTopLevelAndLiquid(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const data = {};
  let inLiquid = false;
  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) {
      continue;
    }
    if (/^\S/.test(line)) {
      inLiquid = false;
      const top = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (top) {
        data[top[1]] = parseScalar(top[2]);
      }
      if (/^liquid:\s*$/.test(line)) {
        inLiquid = true;
      }
      continue;
    }
    if (inLiquid) {
      const liquid = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.+)$/);
      if (liquid) {
        data[liquid[1]] = parseScalar(liquid[2]);
      }
    }
  }
  return data;
}

/**
 * Walks markdown files under a docs root while skipping generated asset folders.
 */
function walkMarkdown(rootPath) {
  if (!fs.existsSync(rootPath)) {
    return [];
  }
  const files = [];
  const stack = [rootPath];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!["images", "assets", "_site", "node_modules"].includes(entry.name)) {
          stack.push(fullPath);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

/**
 * Builds a lookup from Jekyll slug values to public documentation paths.
 */
function buildSlugMap(repoRoot, docRoot, publicBasePath) {
  const map = new Map();
  for (const filePath of walkMarkdown(path.join(repoRoot, docRoot))) {
    const markdown = fs.readFileSync(filePath, "utf8");
    const parsed = parseFrontMatter(markdown);
    if (!parsed.data.slug) {
      continue;
    }
    const relative = path
      .relative(path.join(repoRoot, docRoot), filePath)
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "");
    map.set(parsed.data.slug, `${publicBasePath}/${relative}`.replace(/\/+/g, "/"));
  }
  return map;
}

/**
 * Parses a Liquid condition literal into a comparable JavaScript value.
 */
function parseConditionValue(value) {
  const trimmed = value.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Evaluates the subset of Liquid site conditions supported by the renderer.
 */
function evaluateSiteCondition(expression, site, warnings) {
  const trimmed = expression.trim();
  const direct = trimmed.match(/^site\.([A-Za-z0-9_-]+)$/);
  if (direct) {
    return Boolean(site[direct[1]]);
  }

  const comparison = trimmed.match(/^site\.([A-Za-z0-9_-]+)\s*(==|!=)\s*(.+)$/);
  if (comparison) {
    const actual = site[comparison[1]];
    const expected = parseConditionValue(comparison[3]);
    return comparison[2] === "==" ? actual === expected : actual !== expected;
  }

  warnings.push(`Unresolved conditional: ${trimmed}`);
  return false;
}

/**
 * Renders supported Liquid if/else blocks using site configuration values.
 */
function renderConditionals(markdown, site, warnings) {
  let output = markdown;
  const pattern = /\{%\s*if\s+([^%]+?)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g;
  let previous;
  do {
    previous = output;
    output = output.replace(pattern, (_match, expression, truthy, falsy = "") =>
      evaluateSiteCondition(expression, site, warnings) ? truthy : falsy
    );
  } while (output !== previous);
  return output;
}

/**
 * Renders a site variable and records warnings for unsupported filters.
 */
function renderSiteVariable(key, filter, variables, warnings) {
  if (variables[key] === undefined || variables[key] === null) {
    warnings.push(`Unresolved site variable: ${key}`);
    return `unresolved-site:${key}`;
  }

  if (!filter) {
    return String(variables[key]);
  }

  const dateFilter = filter.match(/^date:\s*["']%Y["']$/);
  if (dateFilter) {
    return String(new Date().getFullYear());
  }

  warnings.push(`Unresolved site filter: ${key} | ${filter}`);
  return String(variables[key]);
}

/**
 * Renders the supported Liquid/Jekyll syntax in a markdown document.
 */
function renderMarkdown(markdown, context) {
  const warnings = [];
  const rawBlocks = [];
  let output = markdown.replace(/\{%\s*raw\s*%\}([\s\S]*?)\{%\s*endraw\s*%\}/g, (_match, body) => {
    const token = `@@KENDO_RAW_${rawBlocks.length}@@`;
    rawBlocks.push(body);
    return token;
  });

  output = renderConditionals(output, context.site, warnings);
  const variables = { ...context.site };

  output = output.replace(/\{%\s*assign\s+([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^%]*?))\s*%\}\s*/g, (_match, key, dquoted, squoted, bare) => {
    variables[key] = dquoted ?? squoted ?? String(bare || "").trim();
    return "";
  });

  output = output.replace(/\{\{\s*site\.([A-Za-z0-9_-]+)\s*(?:\|\s*([^}]+?))?\s*\}\}/g, (_match, key, filter) =>
    renderSiteVariable(key, filter ? filter.trim() : "", variables, warnings)
  );

  output = output.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => {
    if (variables[key] === undefined || variables[key] === null) {
      warnings.push(`Unresolved variable: ${key}`);
      return `unresolved:${key}`;
    }
    return String(variables[key]);
  });

  output = output.replace(/\{%\s*slug\s+([^%\s]+)\s*%\}/g, (match, slug) => {
    const clean = slug.trim().replace(/^["']|["']$/g, "");
    if (!context.slugMap.has(clean)) {
      warnings.push(`Unresolved slug: ${clean}`);
      return `unresolved-slug:${clean}`;
    }
    return context.slugMap.get(clean);
  });

  output = output.replace(/\{%\s*include_relative\s+([^%\s]+)\s*%\}/g, (_match, includePath) => {
    warnings.push(`Unrendered include_relative: ${includePath}`);
    return `[unrendered include_relative: ${includePath}]`;
  });

  output = output.replace(/\{%\s*include\s+([^%\s]+)[^%]*%\}/g, (_match, includePath) => {
    warnings.push(`Unrendered include: ${includePath}`);
    return `[unrendered include: ${includePath}]`;
  });

  output = output.replace(/\{%\s*(endif|else)\s*%\}/g, (_match, tagName) => {
    warnings.push(`Unmatched Liquid control tag removed: ${tagName}`);
    return "";
  });

  output = output.replace(/@@KENDO_RAW_(\d+)@@/g, (_match, index) => rawBlocks[Number(index)] || "");

  return { text: output, warnings: Array.from(new Set(warnings)) };
}

/**
 * Builds render-target metadata and slug maps for each supported doc target.
 */
function targetDefinitions(repoRoot) {
  return [
    {
      render_target: "jquery",
      product: "Kendo UI for jQuery",
      doc_root: "docs",
      docs_builder: "docs/docs-builder.yml",
      jekyll_config: "docs/_config.yml",
      public_base_path: "/kendo-ui"
    },
    {
      render_target: "aspnet-core",
      product: "Telerik UI for ASP.NET Core",
      doc_root: "docs-aspnet",
      docs_builder: "docs-aspnet/docs-builder-core.yml",
      jekyll_config: "docs-aspnet/_config.yml",
      public_base_path: "/aspnet-core"
    },
    {
      render_target: "aspnet-mvc",
      product: "Telerik UI for ASP.NET MVC",
      doc_root: "docs-aspnet",
      docs_builder: "docs-aspnet/docs-builder-mvc.yml",
      jekyll_config: "docs-aspnet/_config-mvc.yml",
      public_base_path: "/aspnet-mvc"
    }
  ].map((target) => {
    const builder = parseTopLevelAndLiquid(path.join(repoRoot, target.docs_builder));
    const config = parseTopLevelAndLiquid(path.join(repoRoot, target.jekyll_config));
    const site = { ...config, ...builder };
    return {
      ...target,
      site,
      slugMap: buildSlugMap(repoRoot, target.doc_root, target.public_base_path)
    };
  });
}

/**
 * Generates the anchor id used for extracted heading text.
 */
function generatedAnchor(heading) {
  return slugify(heading);
}

module.exports = {
  generatedAnchor,
  renderMarkdown,
  targetDefinitions
};
