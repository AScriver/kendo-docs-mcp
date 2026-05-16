const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  API_SECTION_MEMBER_TYPES,
  contentHash,
  extractCodeBlocks,
  extractHeadings,
  extractLinks,
  getRepoRoot,
  normalizeComponentName,
  normalizeSlashes,
  parseFrontMatter,
  repoRelative,
  slugify,
  stableId,
  stripTypeSuffix,
  tokenize
} = require("./lib");
const { GENERATED_DIR, corpusPaths, safeVersionSegment } = require("./corpus");
const { renderMarkdown, targetDefinitions } = require("./render");

const MAX_GUIDE_CHARS = 14000;
const GENERATED_VERSION = 2;

function walkMarkdown(root) {
  const start = path.join(getRepoRoot(), root);
  if (!fs.existsSync(start)) {
    return [];
  }
  const files = [];
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!["images", "assets", "_site", "node_modules"].includes(entry.name)) {
          stack.push(fullPath);
        }
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".md") &&
        !["all-pages.md", "readme.md"].includes(entry.name.toLowerCase())
      ) {
        files.push(fullPath);
      }
    }
  }
  return files.sort((a, b) => repoRelative(a).localeCompare(repoRelative(b)));
}

function sourceType(sourcePath, frontMatter) {
  if (frontMatter.res_type === "api" || sourcePath.startsWith("docs/api/")) {
    return "api";
  }
  if (/\/knowledge-base\//.test(sourcePath)) {
    return "example";
  }
  if (/\/overview\.md$/i.test(sourcePath) || /\/introduction\.md$/i.test(sourcePath)) {
    return "overview";
  }
  if (sourcePath.includes("/controls/") || sourcePath.includes("/framework/") || sourcePath.includes("/html-helpers/")) {
    return "guide";
  }
  return "unknown";
}

function inferComponent(sourcePath, frontMatter, title, h1) {
  if (frontMatter.component) {
    return normalizeComponentName(frontMatter.component);
  }
  if (Array.isArray(frontMatter.components) && frontMatter.components[0] && frontMatter.components[0] !== "general") {
    return normalizeComponentName(frontMatter.components[0]);
  }
  if (typeof frontMatter.components === "string") {
    const match = frontMatter.components.match(/[A-Za-z0-9_-]+/);
    if (match && match[0] !== "general") {
      return normalizeComponentName(match[0]);
    }
  }
  if (sourcePath.startsWith("docs/api/") && title && title !== "Overview") {
    return normalizeComponentName(title);
  }
  const apiMatch = sourcePath.match(/^docs\/api\/javascript\/(?:dataviz\/)?(?:ui|data)\/([^/]+)\.md$/);
  if (apiMatch) {
    return normalizeComponentName(apiMatch[1].replace(/^kendo-/, ""));
  }
  const controlsMatch = sourcePath.match(/^docs(?:-aspnet)?\/(?:html-helpers\/[^/]+\/|controls\/)([^/]+)/);
  if (controlsMatch) {
    return normalizeComponentName(controlsMatch[1]);
  }
  const classMatch = (h1 || "").match(/^#\s+kendo\.(?:ui|data|dataviz\.ui)\.([A-Za-z0-9_]+)/);
  if (classMatch) {
    return classMatch[1];
  }
  return null;
}

function headingPathFor(headings, endOffset) {
  const pathParts = [];
  for (const heading of headings) {
    if (heading.offset > endOffset) {
      break;
    }
    pathParts[heading.level - 1] = heading.text;
    pathParts.length = heading.level;
  }
  return pathParts.filter(Boolean);
}

function getDocumentTitle(frontMatter, body, sourcePath) {
  if (frontMatter.title) {
    return frontMatter.title;
  }
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) {
    return h1[1].trim();
  }
  return path.basename(sourcePath, ".md");
}

function renderFrontMatterValue(value, target, warnings) {
  if (typeof value === "string") {
    const rendered = renderMarkdown(value, target);
    warnings.push(...rendered.warnings);
    return rendered.text.trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderFrontMatterValue(item, target, warnings));
  }
  return value;
}

function renderFrontMatterData(frontMatter, target, warnings) {
  const rendered = {};
  for (const [key, value] of Object.entries(frontMatter)) {
    rendered[key] = renderFrontMatterValue(value, target, warnings);
  }
  return rendered;
}

function memberTypeFromSection(sectionHeading) {
  if (!sectionHeading) {
    return null;
  }
  return API_SECTION_MEMBER_TYPES.get(sectionHeading.toLowerCase()) || null;
}

function createChunk(base, text, headingPath, ordinal, extra = {}) {
  const memberName = extra.member_name || null;
  const memberType = extra.member_type || null;
  const anchorText = headingPath[headingPath.length - 1] || base.title;
  const id = stableId(
    base.render_target,
    base.source_path,
    headingPath.join(" > "),
    memberType || "",
    memberName || "",
    String(ordinal)
  );
  const codeBlocks = extractCodeBlocks(text);
  const links = extractLinks(text);
  const keywords = Array.from(
    new Set(
      [
        base.render_target,
        base.product,
        base.title,
        base.component,
        memberType,
        memberName,
        ...headingPath,
        ...tokenize(base.source_path).filter((token) => token.length > 2)
      ]
        .filter(Boolean)
        .flatMap((value) => [String(value), ...tokenize(String(value))])
        .filter(Boolean)
    )
  );

  return {
    id,
    source_path: base.source_path,
    source_type: base.source_type,
    render_target: base.render_target,
    product: base.product,
    title: base.title,
    heading_path: headingPath,
    component: base.component,
    member_type: memberType || extra.default_member_type || null,
    member_name: memberName,
    text,
    code_blocks: codeBlocks,
    links,
    keywords,
    anchor: slugify(anchorText),
    hash: contentHash(text),
    render_warnings: base.render_warnings || [],
    parent_id: extra.parent_id || null,
    ordinal
  };
}

function splitLargeGuideSection(base, text, headingPath, ordinalStart) {
  if (text.length <= MAX_GUIDE_CHARS) {
    return [createChunk(base, text, headingPath, ordinalStart, { default_member_type: "overview" })];
  }
  const headings = extractHeadings(text).filter((heading) => heading.level >= 3);
  if (!headings.length) {
    const paragraphs = text.split(/\n{2,}/);
    const chunks = [];
    let buffer = "";
    let index = 0;
    for (const paragraph of paragraphs) {
      if (buffer && buffer.length + paragraph.length > MAX_GUIDE_CHARS) {
        chunks.push(createChunk(base, buffer.trim(), [...headingPath, `Part ${index + 1}`], ordinalStart + index, { default_member_type: "overview" }));
        index += 1;
        buffer = "";
      }
      buffer += `${paragraph}\n\n`;
    }
    if (buffer.trim()) {
      chunks.push(createChunk(base, buffer.trim(), [...headingPath, `Part ${index + 1}`], ordinalStart + index, { default_member_type: "overview" }));
    }
    return chunks;
  }

  const parent = createChunk(base, text.slice(0, headings[0].offset).trim(), headingPath, ordinalStart, { default_member_type: "overview" });
  const chunks = parent.text ? [parent] : [];
  const parentId = chunks.length ? parent.id : null;
  for (let i = 0; i < headings.length; i += 1) {
    const start = headings[i].offset;
    const end = i + 1 < headings.length ? headings[i + 1].offset : text.length;
    const childText = text.slice(start, end).trim();
    if (childText) {
      chunks.push(createChunk(base, childText, [...headingPath, headings[i].text], ordinalStart + chunks.length, { default_member_type: "overview", parent_id: parentId }));
    }
  }
  return chunks;
}

function chunkApiDocument(base, body) {
  const headings = extractHeadings(body);
  const chunks = [];
  let ordinal = 0;
  const h2s = headings.filter((heading) => heading.level === 2);
  const firstH2 = h2s[0];
  if (firstH2 && firstH2.offset > 0) {
    const introText = body.slice(0, firstH2.offset).trim();
    if (introText) {
      chunks.push(createChunk(base, introText, headingPathFor(headings, 0), ordinal++, { member_type: "overview" }));
    }
  }
  for (let s = 0; s < h2s.length; s += 1) {
    const section = h2s[s];
    const sectionEnd = s + 1 < h2s.length ? h2s[s + 1].offset : body.length;
    const sectionText = body.slice(section.offset, sectionEnd);
    const sectionMemberType = memberTypeFromSection(section.text);
    const h3s = extractHeadings(sectionText)
      .filter((heading) => heading.level === 3)
      .map((heading) => ({ ...heading, offset: heading.offset + section.offset }));
    if (!h3s.length) {
      const text = body.slice(section.offset, sectionEnd).trim();
      if (text) {
        chunks.push(createChunk(base, text, headingPathFor(headings, section.offset), ordinal++, { member_type: sectionMemberType || "overview" }));
      }
      continue;
    }
    const preamble = body.slice(section.offset, h3s[0].offset).trim();
    if (preamble) {
      chunks.push(createChunk(base, preamble, headingPathFor(headings, section.offset), ordinal++, { member_type: sectionMemberType || "overview" }));
    }
    for (let i = 0; i < h3s.length; i += 1) {
      const start = h3s[i].offset;
      const end = i + 1 < h3s.length ? h3s[i + 1].offset : sectionEnd;
      const text = body.slice(start, end).trim();
      if (text) {
        chunks.push(createChunk(base, text, headingPathFor(headings, start), ordinal++, { member_type: sectionMemberType || "overview", member_name: stripTypeSuffix(h3s[i].text) }));
      }
    }
  }
  return chunks;
}

function chunkGuideDocument(base, body) {
  const headings = extractHeadings(body);
  const h2s = headings.filter((heading) => heading.level === 2);
  const chunks = [];
  let ordinal = 0;
  if (!h2s.length) {
    return [createChunk(base, body.trim(), headingPathFor(headings, 0), ordinal, { default_member_type: "overview" })];
  }
  const firstH2 = h2s[0];
  if (firstH2.offset > 0) {
    const text = body.slice(0, firstH2.offset).trim();
    if (text) {
      chunks.push(createChunk(base, text, headingPathFor(headings, 0), ordinal++, { default_member_type: "overview" }));
    }
  }
  for (let i = 0; i < h2s.length; i += 1) {
    const start = h2s[i].offset;
    const end = i + 1 < h2s.length ? h2s[i + 1].offset : body.length;
    const text = body.slice(start, end).trim();
    if (text) {
      const pieces = splitLargeGuideSection(base, text, headingPathFor(headings, start), ordinal);
      chunks.push(...pieces);
      ordinal += pieces.length;
    }
  }
  return chunks;
}

function buildIndexes(chunks, metadata = {}) {
  const components = new Map();
  const byComponent = {};
  const byMember = {};
  const bySource = {};
  for (const chunk of chunks) {
    if (chunk.component) {
      const key = `${chunk.render_target}::${chunk.component.toLowerCase()}`;
      if (!components.has(key)) {
        components.set(key, { name: chunk.component, render_target: chunk.render_target, product: chunk.product, chunk_count: 0, source_paths: new Set() });
      }
      const entry = components.get(key);
      entry.chunk_count += 1;
      entry.source_paths.add(chunk.source_path);
      byComponent[key] ||= [];
      byComponent[key].push(chunk.id);
    }
    if (chunk.component && chunk.member_name) {
      const memberKey = `${chunk.render_target}::${chunk.component.toLowerCase()}::${chunk.member_name.toLowerCase()}`;
      byMember[memberKey] ||= [];
      byMember[memberKey].push(chunk.id);
    }
    const sourceKey = `${chunk.render_target}::${chunk.source_path}`;
    bySource[sourceKey] ||= [];
    bySource[sourceKey].push(chunk.id);
  }
  return {
    version: GENERATED_VERSION,
    docs_version: metadata.docs_version || null,
    source_git_ref: metadata.source_git_ref || null,
    source_git_commit: metadata.source_git_commit || null,
    generated_at: new Date().toISOString(),
    chunk_count: chunks.length,
    components: Array.from(components.values())
      .map((component) => ({ ...component, source_paths: Array.from(component.source_paths).sort() }))
      .sort((a, b) => a.render_target.localeCompare(b.render_target) || a.name.localeCompare(b.name)),
    by_component: byComponent,
    by_member: byMember,
    by_source: bySource
  };
}

function writeSqlite(chunks, sqlitePath) {
  if (fs.existsSync(sqlitePath)) {
    fs.rmSync(sqlitePath, { force: true });
  }
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      source_type TEXT,
      render_target TEXT,
      product TEXT,
      title TEXT,
      component TEXT,
      member_type TEXT,
      member_name TEXT,
      heading_path TEXT,
      text TEXT,
      code_blocks TEXT,
      links TEXT,
      keywords TEXT,
      anchor TEXT,
      hash TEXT,
      render_warnings TEXT,
      parent_id TEXT,
      ordinal INTEGER
    );
    CREATE VIRTUAL TABLE docs_fts USING fts5(
      id UNINDEXED,
      title,
      component,
      member_type,
      member_name,
      render_target,
      product,
      heading_path,
      keywords,
      text,
      source_path
    );
  `);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (
      id, source_path, source_type, render_target, product, title, component, member_type, member_name,
      heading_path, text, code_blocks, links, keywords, anchor, hash, render_warnings, parent_id, ordinal
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO docs_fts (id, title, component, member_type, member_name, render_target, product, heading_path, keywords, text, source_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN");
  try {
    for (const chunk of chunks) {
      insertChunk.run(
        chunk.id,
        chunk.source_path,
        chunk.source_type,
        chunk.render_target,
        chunk.product,
        chunk.title,
        chunk.component,
        chunk.member_type,
        chunk.member_name,
        JSON.stringify(chunk.heading_path),
        chunk.text,
        JSON.stringify(chunk.code_blocks),
        JSON.stringify(chunk.links),
        JSON.stringify(chunk.keywords),
        chunk.anchor,
        chunk.hash,
        JSON.stringify(chunk.render_warnings),
        chunk.parent_id,
        chunk.ordinal
      );
      insertFts.run(
        chunk.id,
        chunk.title || "",
        chunk.component || "",
        chunk.member_type || "",
        chunk.member_name || "",
        chunk.render_target || "",
        chunk.product || "",
        (chunk.heading_path || []).join(" > "),
        (chunk.keywords || []).join(" "),
        chunk.text || "",
        chunk.source_path
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function gitValue(repoRoot, args) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function main() {
  const repoRoot = getRepoRoot();
  const docsVersion = getArgValue("--version");
  const cleanVersion = docsVersion ? safeVersionSegment(docsVersion) : null;
  const outputDir = cleanVersion ? path.join(GENERATED_DIR, cleanVersion) : GENERATED_DIR;
  const outputPaths = corpusPaths(outputDir);
  const sourceGitRef = getArgValue("--source-git-ref") || cleanVersion || gitValue(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const sourceGitCommit = getArgValue("--source-git-commit") || gitValue(repoRoot, ["rev-parse", "HEAD"]);
  fs.mkdirSync(outputDir, { recursive: true });
  const targets = targetDefinitions(repoRoot);
  const chunks = [];
  const sources = [];

  for (const target of targets) {
    for (const filePath of walkMarkdown(target.doc_root)) {
      const markdown = fs.readFileSync(filePath, "utf8");
      const sourcePath = normalizeSlashes(repoRelative(filePath));
      const parsed = parseFrontMatter(markdown);
      const rendered = renderMarkdown(parsed.body, target);
      const renderWarnings = [...rendered.warnings];
      const renderedFrontMatter = renderFrontMatterData(parsed.data, target, renderWarnings);
      const uniqueWarnings = Array.from(new Set(renderWarnings));
      const title = getDocumentTitle(renderedFrontMatter, rendered.text, sourcePath);
      const h1 = rendered.text.match(/^#\s+(.+)$/m)?.[0] || "";
      const base = {
        source_path: sourcePath,
        source_type: sourceType(sourcePath, renderedFrontMatter),
        render_target: target.render_target,
        product: target.site.product || target.product,
        title,
        component: inferComponent(sourcePath, renderedFrontMatter, title, h1),
        render_warnings: uniqueWarnings
      };
      const docChunks = base.source_type === "api" ? chunkApiDocument(base, rendered.text) : chunkGuideDocument(base, rendered.text);
      for (const chunk of docChunks) {
        chunk.docs_version = cleanVersion;
      }
      chunks.push(...docChunks);
      sources.push({
        source_path: sourcePath,
        source_type: base.source_type,
        render_target: base.render_target,
        product: base.product,
        title,
        component: base.component,
        source_hash: contentHash(markdown),
        chunks: docChunks.length,
        render_warnings: uniqueWarnings
      });
    }
  }

  chunks.sort((a, b) => {
    const target = a.render_target.localeCompare(b.render_target);
    const source = a.source_path.localeCompare(b.source_path);
    return target || source || a.ordinal - b.ordinal || a.id.localeCompare(b.id);
  });

  fs.writeFileSync(outputPaths.chunks, `${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`, "utf8");
  const index = buildIndexes(chunks, {
    docs_version: cleanVersion,
    source_git_ref: sourceGitRef,
    source_git_commit: sourceGitCommit
  });
  fs.writeFileSync(outputPaths.index, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    outputPaths.metadata,
    `${JSON.stringify(
      {
        version: GENERATED_VERSION,
        docs_version: cleanVersion,
        source_git_ref: sourceGitRef,
        source_git_commit: sourceGitCommit,
        generated_at: index.generated_at,
        repo_root: repoRoot,
        targets: targets.map((target) => ({
          render_target: target.render_target,
          doc_root: target.doc_root,
          product: target.site.product || target.product
        })),
        source_count: sources.length,
        chunk_count: chunks.length,
        sources
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeSqlite(chunks, outputPaths.sqlite);
  process.stdout.write(
    `Generated ${chunks.length} chunks from ${sources.length} rendered Markdown target files.\n` +
      `Corpus: ${outputPaths.chunks}\n` +
      `Index: ${outputPaths.index}\n` +
      `SQLite: ${outputPaths.sqlite}\n`
  );
}

main();
