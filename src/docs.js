const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const {
  excerpt,
  readJsonLines,
  scoreChunk,
  tokenize
} = require("./lib");
const { listKendoDocVersions, resolveCorpus } = require("./corpus");
const { detectProjectKendoVersions } = require("./project-version");

const loadedCorpora = new Map();

/**
 * Builds a cache signature from the corpus file paths and modification times.
 */
function corpusSignature(corpus) {
  return [corpus.paths.chunks, corpus.paths.index, corpus.paths.metadata, corpus.paths.sqlite]
    .map((filePath) => `${filePath}:${fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0}`)
    .join("|");
}

/**
 * Loads and caches a generated corpus for the requested docs version.
 */
function loadCorpus(version) {
  const corpus = resolveCorpus(version);
  const signature = corpusSignature(corpus);
  const cached = loadedCorpora.get(corpus.paths.dir);
  if (!cached || cached.signature !== signature) {
    loadedCorpora.set(corpus.paths.dir, {
      ...corpus,
      signature,
      chunksById: new Map(readJsonLines(corpus.paths.chunks).map((chunk) => [chunk.id, chunk])),
      index: fs.existsSync(corpus.paths.index) ? JSON.parse(fs.readFileSync(corpus.paths.index, "utf8")) : {}
    });
  }
  return loadedCorpora.get(corpus.paths.dir);
}

/**
 * Opens the SQLite database attached to a loaded corpus.
 */
function openCorpusDatabase(corpus, readonly = true) {
  return new DatabaseSync(corpus.paths.sqlite, { readOnly: readonly });
}

/**
 * Converts a SQLite chunk row into the in-memory chunk shape.
 */
function parseRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    heading_path: JSON.parse(row.heading_path || "[]"),
    code_blocks: JSON.parse(row.code_blocks || "[]"),
    links: JSON.parse(row.links || "[]"),
    keywords: JSON.parse(row.keywords || "[]"),
    render_warnings: JSON.parse(row.render_warnings || "[]")
  };
}

/**
 * Gets a chunk from the default resolved corpus by id.
 */
function getChunk(id) {
  return getChunkFromCorpus(loadCorpus(), id);
}

/**
 * Gets a chunk by id from a specific loaded corpus, falling back to SQLite.
 */
function getChunkFromCorpus(corpus, id) {
  const cached = corpus.chunksById.get(id);
  if (cached) {
    return cached;
  }
  const db = openCorpusDatabase(corpus);
  try {
    return parseRow(db.prepare("SELECT * FROM chunks WHERE id = ?").get(id));
  } finally {
    db.close();
  }
}

/**
 * Creates the compact search-result shape returned by lookup tools.
 */
function resultSummary(chunk, query) {
  return {
    id: chunk.id,
    docs_version: chunk.docs_version || null,
    source_git_ref: chunk.source_git_ref || null,
    source_git_commit: chunk.source_git_commit || null,
    title: chunk.title,
    render_target: chunk.render_target,
    product: chunk.product,
    component: chunk.component,
    member_type: chunk.member_type,
    member_name: chunk.member_name,
    heading_path: chunk.heading_path,
    source_path: chunk.source_path,
    excerpt: excerpt(chunk.text, query)
  };
}

/**
 * Converts free text into a conservative SQLite FTS query string.
 */
function ftsQuery(query) {
  const terms = tokenize(query)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => /^[a-z0-9_.-]+$/i.test(term));
  if (!terms.length) {
    return "";
  }
  return terms.map((term) => `"${term}"`).join(" AND ");
}

/**
 * Fills version and source metadata from the corpus when a chunk omits it.
 */
function withCorpusMetadata(chunk, corpus) {
  return {
    ...chunk,
    docs_version: chunk.docs_version || corpus.docs_version || null,
    source_git_ref: chunk.source_git_ref || corpus.metadata.source_git_ref || null,
    source_git_commit: chunk.source_git_commit || corpus.metadata.source_git_commit || null
  };
}

/**
 * Searches the local Kendo docs corpus with optional component and type filters.
 */
function searchKendoDocs({ query, component, source_type, member_type, render_target, version, limit = 10 } = {}) {
  const corpus = loadCorpus(version);
  if (!query || !query.trim()) {
    throw new Error("query is required");
  }
  const max = Math.max(1, Math.min(Number(limit) || 10, 50));
  const filters = { component, source_type, member_type, render_target };
  const fts = ftsQuery(query);
  let candidates = [];

  if (fts) {
    const where = ["docs_fts MATCH ?"];
    const params = [fts];
    if (component) {
      where.push("lower(chunks.component) = lower(?)");
      params.push(component);
    }
    if (render_target) {
      where.push("chunks.render_target = ?");
      params.push(render_target);
    }
    if (source_type) {
      where.push("chunks.source_type = ?");
      params.push(source_type);
    }
    if (member_type) {
      where.push("chunks.member_type = ?");
      params.push(member_type);
    }

    const sql = `
      SELECT chunks.*, bm25(docs_fts, 4.0, 5.0, 3.0, 4.0, 3.0, 2.0, 1.0, 0.5) AS rank
      FROM docs_fts
      JOIN chunks ON chunks.id = docs_fts.id
      WHERE ${where.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;
    const db = openCorpusDatabase(corpus);
    try {
      candidates = db.prepare(sql).all(...params, Math.max(max * 4, 25)).map(parseRow).map((chunk) => withCorpusMetadata(chunk, corpus));
    } catch {
      candidates = [];
    } finally {
      db.close();
    }
  }

  if (candidates.length < max) {
    for (const rawChunk of corpus.chunksById.values()) {
      const chunk = withCorpusMetadata(rawChunk, corpus);
      if (component && (!chunk.component || chunk.component.toLowerCase() !== component.toLowerCase())) {
        continue;
      }
      if (render_target && chunk.render_target !== render_target) {
        continue;
      }
      if (source_type && chunk.source_type !== source_type) {
        continue;
      }
      if (member_type && chunk.member_type !== member_type) {
        continue;
      }
      candidates.push(chunk);
    }
  }

  const seen = new Set();
  return candidates
    .filter((chunk) => {
      if (seen.has(chunk.id)) {
        return false;
      }
      seen.add(chunk.id);
      return true;
    })
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, query, filters) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.source_path.localeCompare(b.chunk.source_path))
    .slice(0, max)
    .map((item) => resultSummary(item.chunk, query));
}

/**
 * Returns a full documentation chunk by deterministic id.
 */
function getKendoDoc({ id, include_neighbors = false, version } = {}) {
  if (!id) {
    throw new Error("id is required");
  }
  const corpus = loadCorpus(version);
  const chunk = getChunkFromCorpus(corpus, id);
  if (!chunk) {
    throw new Error(`No Kendo doc chunk found for id ${id}`);
  }

  const output = {
    id: chunk.id,
    docs_version: chunk.docs_version || corpus.docs_version || null,
    source_git_ref: chunk.source_git_ref || corpus.metadata.source_git_ref || null,
    source_git_commit: chunk.source_git_commit || corpus.metadata.source_git_commit || null,
    source_path: chunk.source_path,
    source_type: chunk.source_type,
    render_target: chunk.render_target,
    product: chunk.product,
    title: chunk.title,
    heading_path: chunk.heading_path,
    component: chunk.component,
    member_type: chunk.member_type,
    member_name: chunk.member_name,
    anchor: chunk.anchor,
    hash: chunk.hash,
    render_warnings: chunk.render_warnings,
    text: chunk.text,
    code_blocks: chunk.code_blocks,
    links: chunk.links
  };

  if (include_neighbors) {
    const ids = corpus.index.by_source[`${chunk.render_target}::${chunk.source_path}`] || [];
    const idx = ids.indexOf(id);
    output.neighbors = {
      previous: idx > 0 ? resultSummary(withCorpusMetadata(getChunkFromCorpus(corpus, ids[idx - 1]), corpus), "") : null,
      next: idx >= 0 && idx + 1 < ids.length ? resultSummary(withCorpusMetadata(getChunkFromCorpus(corpus, ids[idx + 1]), corpus), "") : null
    };
  }
  return output;
}

/**
 * Looks up exact or best-matching API member documentation for a component.
 */
function getKendoApiMember({ component, member_name, member_type, render_target = "jquery", version } = {}) {
  const corpus = loadCorpus(version);
  if (!component || !member_name) {
    throw new Error("component and member_name are required");
  }
  const candidateNames = [member_name];
  const parts = member_name.split(".");
  while (parts.length > 1) {
    parts.pop();
    candidateNames.push(parts.join("."));
  }

  let ids = [];
  for (const candidate of candidateNames) {
    const key = `${render_target}::${component.toLowerCase()}::${candidate.toLowerCase()}`;
    ids = corpus.index.by_member[key] || [];
    if (ids.length) {
      break;
    }
  }
  let matches = ids.map((id) => getChunkFromCorpus(corpus, id));

  if (member_type) {
    matches = matches.filter((chunk) => chunk.member_type === member_type);
  }

  if (!matches.length) {
    const query = `${component} ${member_name} ${member_type || ""}`.trim();
    matches = searchKendoDocs({ query, component, member_type, source_type: "api", render_target, version, limit: 5 })
      .map((result) => getChunkFromCorpus(corpus, result.id))
      .filter(Boolean);
  }

  return matches.map((chunk) => ({
    id: chunk.id,
    docs_version: chunk.docs_version || corpus.docs_version || null,
    source_git_ref: chunk.source_git_ref || corpus.metadata.source_git_ref || null,
    source_git_commit: chunk.source_git_commit || corpus.metadata.source_git_commit || null,
    title: chunk.title,
    render_target: chunk.render_target,
    product: chunk.product,
    component: chunk.component,
    member_type: chunk.member_type,
    member_name: chunk.member_name,
    heading_path: chunk.heading_path,
    source_path: chunk.source_path,
    anchor: chunk.anchor,
    text: chunk.text,
    code_blocks: chunk.code_blocks,
    links: chunk.links,
    render_warnings: chunk.render_warnings
  }));
}

/**
 * Lists components discovered in the loaded docs corpus.
 */
function listKendoComponents({ query, render_target, version } = {}) {
  const corpus = loadCorpus(version);
  const normalized = query ? query.toLowerCase() : null;
  return corpus.index.components
    .filter((component) => !render_target || component.render_target === render_target)
    .filter((component) => !normalized || component.name.toLowerCase().includes(normalized))
    .map((component) => ({
      name: component.name,
      docs_version: corpus.docs_version || null,
      source_git_ref: corpus.metadata.source_git_ref || null,
      source_git_commit: corpus.metadata.source_git_commit || null,
      render_target: component.render_target,
      product: component.product,
      chunk_count: component.chunk_count,
      source_paths: component.source_paths.slice(0, 20)
    }));
}

/**
 * Searches for documentation chunks that contain runnable or illustrative code.
 */
function findKendoExamples({ query, component, render_target, version, limit = 10 } = {}) {
  const corpus = loadCorpus(version);
  if (!query || !query.trim()) {
    throw new Error("query is required");
  }
  const max = Math.max(1, Math.min(Number(limit) || 10, 50));
  return searchKendoDocs({ query, component, render_target, version, limit: max * 3 })
    .map((result) => getChunkFromCorpus(corpus, result.id))
    .filter((chunk) => chunk.code_blocks && chunk.code_blocks.length > 0)
    .slice(0, max)
    .map((chunk) => ({
      ...resultSummary(withCorpusMetadata(chunk, corpus), query),
      code_blocks: chunk.code_blocks
    }));
}

/**
 * Dispatches an MCP tool name to the matching local implementation.
 */
function callTool(name, args) {
  switch (name) {
    case "search_kendo_docs":
      return searchKendoDocs(args);
    case "get_kendo_doc":
      return getKendoDoc(args);
    case "get_kendo_api_member":
      return getKendoApiMember(args);
    case "list_kendo_components":
      return listKendoComponents(args);
    case "find_kendo_examples":
      return findKendoExamples(args);
    case "list_kendo_doc_versions":
      return listKendoDocVersions();
    case "detect_project_kendo_versions":
      return detectProjectKendoVersions(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = {
  callTool,
  findKendoExamples,
  getKendoApiMember,
  getKendoDoc,
  listKendoComponents,
  searchKendoDocs
};
