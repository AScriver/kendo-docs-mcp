# Telerik Kendo Docs MCP

Standalone local tooling for extracting rendered, source-linked Telerik/Kendo documentation from a local `kendo-ui-core` checkout and serving it through MCP.

The generated corpus stores rendered documentation text only. It does not keep raw Markdown with `{{ site.* }}` placeholders as a model-facing field.

## Quick Teammate Setup

Prerequisites:

- Node.js 22.5.0 or newer.
- Git.
- Codex Desktop.

The server uses built-in Node SQLite support and has no npm package dependencies.

Quick Setup:

```powershell
git clone https://github.com/AScriver/kendo-docs-mcp.git
cd kendo-docs-mcp
npm run setup:source
npm run build:version -- --version 2025.3.812
npm run setup:codex -- --kendo-version 2025.3.812
```

`setup:source` reuses `KENDO_DOCS_REPO_ROOT` or a sibling `..\kendo-ui-core` checkout when present. If neither exists, it clones `https://github.com/telerik/kendo-ui-core.git` to `..\kendo-ui-core`.

`setup:codex` prints a TOML block with local paths for that machine. Paste the printed block into `%USERPROFILE%\.codex\config.toml`, then restart Codex so the MCP server is loaded.

Do not copy another developer's TOML block unless the repo path is identical. The generated block contains machine-specific `cwd` and `src/server.js` paths.

Run the smoke test from this repo after building the corpus:

```powershell
npm run smoke
```

The docs corpus is ignored by git, so each teammate needs to run `npm run build:version -- --version 2025.3.812` unless someone gives them a generated corpus separately. The Kendo source checkout is only needed for rebuilding the corpus; runtime uses the generated files.

To build a single current corpus instead of a versioned corpus:

```powershell
npm run build:docs
```

For a different versioned corpus from a Kendo UI Core tag:

```powershell
npm run build:version -- --version <kendo-version>
```

Generate the Codex MCP configuration block for this machine:

```powershell
npm run setup:codex
```

If you already know which versioned docs corpus this MCP should use by default, include it in the generated config:

```powershell
npm run setup:codex -- --kendo-version <kendo-version>
```

The smoke test starts the MCP server over stdio, verifies `initialize`, lists the tools, calls `list_kendo_doc_versions`, and runs a one-result `search_kendo_docs` query when a generated corpus is available.

## Source Repository

The Kendo UI Core repository is required only when rebuilding the generated corpus. The setup helper reuses an existing local checkout or clones it from GitHub:

```powershell
npm run setup:source
```

By default, the helper checks `KENDO_DOCS_REPO_ROOT`, then `..\kendo-ui-core` next to this repo. You can still point the extractor at a specific checkout:

```powershell
node src/extract.js --repo-root "C:\Code\kendo-ui-core"
```

## Render Targets

The extractor builds product-specific rendered variants:

- `jquery`: `docs/docs-builder.yml` + `docs/_config.yml`
- `aspnet-core`: `docs-aspnet/docs-builder-core.yml` + `docs-aspnet/_config.yml`
- `aspnet-mvc`: `docs-aspnet/docs-builder-mvc.yml` + `docs-aspnet/_config-mvc.yml`

The render pass resolves:

- Liquid variables such as `{{ site.product }}`.
- Simple `{% if site.core %}`, `{% if site.mvc %}`, and `{% else %}` branches.
- `{% slug ... %}` links through front matter slug maps.

Unresolved include-style tags are reported in `render_warnings`; raw source text is not stored in chunks.

## Build

```powershell
npm run build:docs
```

Generated output is written to the legacy `generated/` corpus:

- `chunks.jsonl`: rendered documentation chunks.
- `index.json`: component, member, and source-path lookup indexes.
- `metadata.json`: source file and generation metadata.
- `docs.sqlite`: SQLite FTS5 search index.

To build a versioned corpus from a Kendo UI Core git tag without touching a dirty source checkout, use:

```powershell
npm run build:version -- --version 2025.3.812
```

The helper creates or reuses a detached git worktree under `.cache/kendo-worktrees/<version>/`, then writes the generated docs to `generated/<version>/`. Versioned `metadata.json` and `index.json` include:

- `docs_version`
- `source_git_ref`
- `source_git_commit`

At runtime, a supplied tool `version` always selects `generated/<version>/`. If `version` is omitted and `KENDO_DOCS_VERSION` is set in the MCP config environment, the server uses that configured version. Without `KENDO_DOCS_VERSION`, it preserves legacy `generated/` behavior when no versioned corpus exists, uses the only available versioned corpus when exactly one exists, and asks for an explicit version when multiple versioned corpora exist.

## Run The MCP Server

After `generated/` has been built, the MCP server reads only the local generated corpus and index files. It does not need `KENDO_DOCS_REPO_ROOT` at runtime.

```powershell
npm start
```

For Codex, prefer the generated local config:

```powershell
npm run setup:codex
```

Example Codex MCP configuration:

```toml
[mcp_servers.kendo-docs]
command = "node"
args = ["--no-warnings", "C:/Code/kendo-docs-mcp/src/server.js"]
cwd = "C:/Code/kendo-docs-mcp"

[mcp_servers.kendo-docs.env]
KENDO_DOCS_VERSION = "2025.3.812"
```

## Tools

- `search_kendo_docs`: search rendered docs by query, component, source type, member type, and render target.
- `get_kendo_doc`: fetch a full rendered chunk by `id`, optionally with neighboring chunks.
- `get_kendo_api_member`: exact or best matching API member lookup by component, member name, member type, and render target.
- `list_kendo_components`: list discovered components/widgets/modules, optionally by render target.
- `find_kendo_examples`: find rendered chunks with matching code examples.
- `list_kendo_doc_versions`: list available generated corpora, including version metadata, targets, and chunk counts.
- `detect_project_kendo_versions`: scan a project for `Telerik.UI.for.AspNet.Core` and Kendo CDN script versions, then recommend a docs corpus version.

The lookup tools also accept optional `version`, which overrides `KENDO_DOCS_VERSION` for that call:

```json
{
  "query": "Grid Excel export",
  "component": "Grid",
  "render_target": "aspnet-core",
  "version": "2025.3.812"
}
```

Project detection is scoped to Telerik/Kendo versions only. It does not inspect or report jQuery versions.

## Validate

Quick MCP smoke test:

```powershell
npm run smoke
```

Full corpus validation:

```powershell
npm run validate
```

Validation checks targeted Kendo lookups and confirms rendered product text such as `Kendo UI for jQuery Grid Overview` appears without raw Liquid placeholders.
