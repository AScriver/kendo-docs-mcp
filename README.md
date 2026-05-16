# Kendo Docs MCP

Standalone local tooling for extracting rendered, source-linked Telerik/Kendo documentation from a local `kendo-ui-core` checkout and serving it through MCP.

The generated corpus stores rendered documentation text only. It does not keep raw Markdown with `{{ site.* }}` placeholders as a model-facing field.

## Source Repository

The Kendo UI Core repository is required only when rebuilding the generated corpus. Point the extractor at a local checkout:

```powershell
$env:KENDO_DOCS_REPO_ROOT = "C:\Users\AustinScriver\Code\kendo-ui-core"
```

You can also pass the repo root directly:

```powershell
node src/extract.js --repo-root "C:\Users\AustinScriver\Code\kendo-ui-core"
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

Generated output is written to `generated/`:

- `chunks.jsonl`: rendered documentation chunks.
- `index.json`: component, member, and source-path lookup indexes.
- `metadata.json`: source file and generation metadata.
- `docs.sqlite`: SQLite FTS5 search index.

## Run The MCP Server

After `generated/` has been built, the MCP server reads only the local generated corpus and index files. It does not need `KENDO_DOCS_REPO_ROOT` at runtime.

```powershell
npm start
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "kendo-docs": {
      "command": "node",
      "args": ["C:/Users/AustinScriver/Code/kendo-docs-mcp/src/server.js"],
      "cwd": "C:/Users/AustinScriver/Code/kendo-docs-mcp"
    }
  }
}
```

## Tools

- `search_kendo_docs`: search rendered docs by query, component, source type, member type, and render target.
- `get_kendo_doc`: fetch a full rendered chunk by `id`, optionally with neighboring chunks.
- `get_kendo_api_member`: exact or best matching API member lookup by component, member name, member type, and render target.
- `list_kendo_components`: list discovered components/widgets/modules, optionally by render target.
- `find_kendo_examples`: find rendered chunks with matching code examples.

## Validate

```powershell
npm run validate
```

Validation checks targeted Kendo lookups and confirms rendered product text such as `Kendo UI for jQuery Grid Overview` appears without raw Liquid placeholders.
