const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ensureKendoSourceRepo } = require("./source-repo");

const TOOL_ROOT = path.resolve(__dirname, "..");
const GENERATED_DIR = process.env.KENDO_DOCS_GENERATED_DIR
  ? path.resolve(process.env.KENDO_DOCS_GENERATED_DIR)
  : path.join(TOOL_ROOT, "generated");
const CHUNKS_PATH = path.join(GENERATED_DIR, "chunks.jsonl");
const META_PATH = path.join(GENERATED_DIR, "metadata.json");
const INDEX_PATH = path.join(GENERATED_DIR, "index.json");
const SQLITE_PATH = path.join(GENERATED_DIR, "docs.sqlite");

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function getRepoRoot() {
  const configured = getArgValue("--repo-root");
  if (configured) {
    return path.resolve(configured);
  }
  return ensureKendoSourceRepo();
}

const API_SECTION_MEMBER_TYPES = new Map([
  ["configuration", "configuration"],
  ["methods", "method"],
  ["class methods", "method"],
  ["static methods", "method"],
  ["events", "event"],
  ["fields", "field"],
  ["properties", "property"],
  ["overview", "overview"]
]);

function repoRelative(filePath) {
  return path.relative(getRepoRoot(), filePath).replace(/\\/g, "/");
}

function stableId(...parts) {
  return crypto
    .createHash("sha1")
    .update(parts.join("\n"))
    .digest("hex")
    .slice(0, 16);
}

function contentHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, "/");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z0-9#]+;/gi, "")
    .replace(/[^a-z0-9\s._-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function stripTypeSuffix(heading) {
  return heading.replace(/\s+`[^`]+`.*$/u, "").trim();
}

function titleCaseIdentifier(value) {
  if (!value) {
    return null;
  }
  const cleaned = value.replace(/[-_]+/g, " ").trim();
  return cleaned
    .split(/\s+/)
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join("");
}

function normalizeComponentName(value) {
  const known = new Map([
    ["aiprompt", "AIPrompt"],
    ["combobox", "ComboBox"],
    ["datasource", "DataSource"],
    ["dropdownlist", "DropDownList"],
    ["dropdowntree", "DropDownTree"],
    ["filemanager", "FileManager"],
    ["multicolumncombobox", "MultiColumnComboBox"],
    ["multiselect", "MultiSelect"],
    ["observablearray", "ObservableArray"],
    ["observableobject", "ObservableObject"],
    ["pdfviewer", "PDFViewer"],
    ["pivotgrid", "PivotGrid"],
    ["pivotgridv2", "PivotGridV2"],
    ["qrcode", "QRCode"],
    ["treelist", "TreeList"],
    ["treeview", "TreeView"]
  ]);
  if (!value) {
    return null;
  }
  const key = String(value).replace(/[-_\s]+/g, "").toLowerCase();
  return known.get(key) || titleCaseIdentifier(value);
}

function parseFrontMatter(markdown) {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return { data: {}, body: markdown, raw: "" };
  }
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { data: {}, body: markdown, raw: "" };
  }
  const raw = match[1];
  const data = {};
  for (const line of raw.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      continue;
    }
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      data[kv[1]] = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      data[kv[1]] = value;
    }
  }
  return { data, body: markdown.slice(match[0].length), raw };
}

function extractHeadings(markdown) {
  const headings = [];
  const lines = markdown.split(/\r?\n/);
  let offset = 0;
  let inFence = false;
  for (const line of lines) {
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      inFence = !inFence;
    }
    if (!inFence) {
      const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (match) {
        headings.push({
          level: match[1].length,
          text: match[2].trim(),
          offset,
          line
        });
      }
    }
    offset += line.length + 1;
  }
  return headings;
}

function extractCodeBlocks(markdown) {
  const blocks = [];
  const fenced = /```([^\r\n`]*)\r?\n([\s\S]*?)\r?\n```/g;
  let match;
  while ((match = fenced.exec(markdown)) !== null) {
    blocks.push({
      language: match[1].trim() || null,
      text: match[2]
    });
  }

  const lines = markdown.split(/\r?\n/);
  let start = null;
  let current = [];
  for (const line of lines) {
    if (/^(    |\t)/.test(line)) {
      if (start === null) {
        start = true;
      }
      current.push(line.replace(/^(    |\t)/, ""));
    } else {
      if (current.length >= 2) {
        blocks.push({ language: null, text: current.join("\n") });
      }
      start = null;
      current = [];
    }
  }
  if (start && current.length >= 2) {
    blocks.push({ language: null, text: current.join("\n") });
  }
  return blocks;
}

function extractLinks(markdown) {
  const links = [];
  const markdownLinks = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = markdownLinks.exec(markdown)) !== null) {
    links.push({
      text: match[1],
      href: match[2],
      type: /^https?:\/\//i.test(match[2]) ? "external" : "internal"
    });
  }
  const liquidSlugs = /\{%\s*slug\s+([^%\s]+)\s*%\}/g;
  while ((match = liquidSlugs.exec(markdown)) !== null) {
    links.push({ text: "slug", href: match[0], type: "liquid-slug", slug: match[1] });
  }
  return links;
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) {
    throw new Error(`Index not found at ${INDEX_PATH}. Run npm run build:docs first.`);
  }
  return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
}

function openDatabase(readonly = true) {
  if (!fs.existsSync(SQLITE_PATH)) {
    throw new Error(`SQLite index not found at ${SQLITE_PATH}. Run npm run build:docs first.`);
  }
  return new DatabaseSync(SQLITE_PATH, { readOnly: readonly });
}

function tokenize(value) {
  return (value || "")
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9_.-]+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function searchTerms(query) {
  return tokenize(query).filter((term) => term.length > 1);
}

function scoreChunk(chunk, query, filters = {}) {
  const terms = searchTerms(query);
  const haystacks = [
    chunk.title,
    chunk.component,
    chunk.member_name,
    chunk.member_type,
    ...(chunk.heading_path || []),
    ...(chunk.keywords || []),
    chunk.text
  ].join(" ").toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (chunk.component && chunk.component.toLowerCase() === term) {
      score += 20;
    }
    if (chunk.member_name && chunk.member_name.toLowerCase() === term) {
      score += 18;
    }
    if ((chunk.heading_path || []).join(" ").toLowerCase().includes(term)) {
      score += 8;
    }
    if (haystacks.includes(term)) {
      score += 2;
    }
  }

  if (terms.some((term) => term === "template" || term === "templates" || term === "syntax")) {
    if (chunk.source_path && chunk.source_path.includes("docs/framework/templates/")) {
      score += 35;
    }
    if (/template/i.test(chunk.title || "")) {
      score += 10;
    }
  }

  if (filters.component && chunk.component && chunk.component.toLowerCase() === filters.component.toLowerCase()) {
    score += 15;
  }
  if (filters.member_type && chunk.member_type === filters.member_type) {
    score += 10;
  }
  if (filters.source_type && chunk.source_type === filters.source_type) {
    score += 6;
  }
  return score;
}

function excerpt(text, query, maxLength = 360) {
  const compact = (text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  const terms = searchTerms(query);
  const lower = compact.toLowerCase();
  let start = 0;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0) {
      start = Math.max(0, idx - Math.floor(maxLength / 3));
      break;
    }
  }
  const slice = compact.slice(start, start + maxLength);
  return `${start > 0 ? "..." : ""}${slice}${start + maxLength < compact.length ? "..." : ""}`;
}

function validateGeneratedCorpus() {
  if (!fs.existsSync(CHUNKS_PATH) || !fs.existsSync(INDEX_PATH) || !fs.existsSync(SQLITE_PATH)) {
    throw new Error("Generated corpus/index files are missing. Run npm run build:docs first.");
  }
}

module.exports = {
  API_SECTION_MEMBER_TYPES,
  CHUNKS_PATH,
  GENERATED_DIR,
  INDEX_PATH,
  META_PATH,
  SQLITE_PATH,
  TOOL_ROOT,
  contentHash,
  excerpt,
  extractCodeBlocks,
  extractHeadings,
  extractLinks,
  getRepoRoot,
  loadIndex,
  normalizeSlashes,
  openDatabase,
  parseFrontMatter,
  readJsonLines,
  repoRelative,
  scoreChunk,
  slugify,
  stableId,
  stripTypeSuffix,
  titleCaseIdentifier,
  normalizeComponentName,
  tokenize,
  validateGeneratedCorpus
};
