const {
  CHUNKS_PATH,
  excerpt,
  loadIndex,
  openDatabase,
  readJsonLines,
  scoreChunk,
  tokenize,
  validateGeneratedCorpus
} = require("./lib");

let chunksById = null;
let indexCache = null;

function ensureLoaded() {
  validateGeneratedCorpus();
  if (!chunksById) {
    chunksById = new Map(readJsonLines(CHUNKS_PATH).map((chunk) => [chunk.id, chunk]));
  }
  if (!indexCache) {
    indexCache = loadIndex();
  }
}

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

function getChunk(id) {
  ensureLoaded();
  const cached = chunksById.get(id);
  if (cached) {
    return cached;
  }
  const db = openDatabase();
  try {
    return parseRow(db.prepare("SELECT * FROM chunks WHERE id = ?").get(id));
  } finally {
    db.close();
  }
}

function resultSummary(chunk, query) {
  return {
    id: chunk.id,
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

function ftsQuery(query) {
  const terms = tokenize(query)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => /^[a-z0-9_.-]+$/i.test(term));
  if (!terms.length) {
    return "";
  }
  return terms.map((term) => `"${term}"`).join(" AND ");
}

function searchKendoDocs({ query, component, source_type, member_type, render_target, limit = 10 } = {}) {
  ensureLoaded();
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
    const db = openDatabase();
    try {
      candidates = db.prepare(sql).all(...params, Math.max(max * 4, 25)).map(parseRow);
    } catch {
      candidates = [];
    } finally {
      db.close();
    }
  }

  if (candidates.length < max) {
    for (const chunk of chunksById.values()) {
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

function getKendoDoc({ id, include_neighbors = false } = {}) {
  if (!id) {
    throw new Error("id is required");
  }
  ensureLoaded();
  const chunk = getChunk(id);
  if (!chunk) {
    throw new Error(`No Kendo doc chunk found for id ${id}`);
  }

  const output = {
    id: chunk.id,
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
    const ids = indexCache.by_source[`${chunk.render_target}::${chunk.source_path}`] || [];
    const idx = ids.indexOf(id);
    output.neighbors = {
      previous: idx > 0 ? resultSummary(getChunk(ids[idx - 1]), "") : null,
      next: idx >= 0 && idx + 1 < ids.length ? resultSummary(getChunk(ids[idx + 1]), "") : null
    };
  }
  return output;
}

function getKendoApiMember({ component, member_name, member_type, render_target = "jquery" } = {}) {
  ensureLoaded();
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
    ids = indexCache.by_member[key] || [];
    if (ids.length) {
      break;
    }
  }
  let matches = ids.map(getChunk);

  if (member_type) {
    matches = matches.filter((chunk) => chunk.member_type === member_type);
  }

  if (!matches.length) {
    const query = `${component} ${member_name} ${member_type || ""}`.trim();
    matches = searchKendoDocs({ query, component, member_type, source_type: "api", render_target, limit: 5 })
      .map((result) => getChunk(result.id))
      .filter(Boolean);
  }

  return matches.map((chunk) => ({
    id: chunk.id,
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

function listKendoComponents({ query, render_target } = {}) {
  ensureLoaded();
  const normalized = query ? query.toLowerCase() : null;
  return indexCache.components
    .filter((component) => !render_target || component.render_target === render_target)
    .filter((component) => !normalized || component.name.toLowerCase().includes(normalized))
    .map((component) => ({
      name: component.name,
      render_target: component.render_target,
      product: component.product,
      chunk_count: component.chunk_count,
      source_paths: component.source_paths.slice(0, 20)
    }));
}

function findKendoExamples({ query, component, render_target, limit = 10 } = {}) {
  ensureLoaded();
  if (!query || !query.trim()) {
    throw new Error("query is required");
  }
  const max = Math.max(1, Math.min(Number(limit) || 10, 50));
  return searchKendoDocs({ query, component, render_target, limit: max * 3 })
    .map((result) => getChunk(result.id))
    .filter((chunk) => chunk.code_blocks && chunk.code_blocks.length > 0)
    .slice(0, max)
    .map((chunk) => ({
      ...resultSummary(chunk, query),
      code_blocks: chunk.code_blocks
    }));
}

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
