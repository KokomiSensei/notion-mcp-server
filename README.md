# Notion MCP Server

![License](https://img.shields.io/badge/license-MIT-green)
![TypeScript](https://img.shields.io/badge/TypeScript-4.9+-blue)
![Model Context Protocol](https://img.shields.io/badge/MCP-Enabled-purple)
[![smithery badge](https://smithery.ai/badge/@awkoy/notion-mcp-server)](https://smithery.ai/server/@awkoy/notion-mcp-server)
![NPM Downloads](https://img.shields.io/npm/dw/notion-mcp-server)
![Stars](https://img.shields.io/github/stars/awkoy/notion-mcp-server)

**Notion MCP Server** is a Model Context Protocol (MCP) server implementation that enables AI assistants to interact with Notion's API. This production-ready server provides a complete set of tools and endpoints for reading, creating, and modifying Notion content through natural language interactions.

> 🚀 **v2.0.0 — Execute-first surface.** The whole API collapses to two tools: `notion_execute` and `notion_describe`. Validation errors return the schema + a working example, so an LLM can self-heal in one round-trip. Every mutating op is batchable through a single `{ items: [...] }` envelope, with atomic mode + best-effort rollback + idempotency keys. See [MIGRATION.md](./MIGRATION.md) if you're upgrading from v1.x.

<a href="https://glama.ai/mcp/servers/zrh07hteaa">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/zrh07hteaa/badge" />
</a>

## 📑 Table of Contents

- [Quick start](#-quick-start)
  - [Option 1 — Personal Access Token (recommended)](#option-1--personal-access-token-recommended)
  - [Option 2 — Internal Integration (legacy)](#option-2--internal-integration-legacy)
  - [Option 3 — Docker](#option-3--docker)
  - [Optional: `NOTION_PAGE_ID`](#optional-notion_page_id)
  - [Cursor / Claude Desktop](#cursor--claude-desktop)
- [Features](#-features)
- [Documentation](#-documentation)
  - [Available Tools](#available-tools)
  - [Available Resources](#available-resources)
- [Development](#-development)
- [Technical Details](#-technical-details)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

## 🚀 Quick start

> **Upgrading from v1.x?** v2.0.0 replaces the five `notion_*` tools with two (`notion_execute` + `notion_describe`). The install paths below are unchanged — your `NOTION_TOKEN` continues to work — but any client code that hard-codes the old tool names needs the rename described in [MIGRATION.md](./MIGRATION.md).

### Option 1 — Personal Access Token (recommended)

A Personal Access Token (PAT) acts as you. It sees every page you can see — no per-page "Connect" dance in Notion's UI.

1. Open Notion → **Settings → My Settings → Personal Access Tokens** → **Generate**.
2. Copy the `ntn_...` token.
3. Add the MCP server (Claude Code shown; equivalent for Cursor and Claude Desktop below):

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_paste_your_token_here \
  -- node /absolute/path/to/notion-mcp-server/build/index.js
```

That's it. The PAT does not expire under your control.

### Option 2 — Internal Integration (legacy)

Use this if you specifically want a workspace-scoped integration with explicit per-page access.

1. Open Notion → **Settings → Connections → Develop or manage integrations** → **New integration**.
2. Copy the Internal Integration Secret (`ntn_...` on new integrations; `secret_...` on older ones).
3. Use the same `claude mcp add` command as above — the env var is identical.
4. **Important:** open each page or database in Notion's UI and click **• • • → Connect → \<your integration name\>** to grant access. This is the per-page friction that PATs eliminate.

### Option 3 — Docker

Run the published image — no clone, no `npm install`, no Node version juggling.

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_paste_your_token_here \
  -- docker run --rm -i -e NOTION_TOKEN ghcr.io/awkoy/notion-mcp-server:latest
```

The `-i` flag is required (stdio transport). The bare `-e NOTION_TOKEN` (no `=value`) forwards the env var from the parent process — Claude Code sets it from the `-e` flag above.

**Cursor / Claude Desktop:**

```json
{
  "mcpServers": {
    "notion": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "NOTION_TOKEN",
        "ghcr.io/awkoy/notion-mcp-server:latest"
      ],
      "env": {
        "NOTION_TOKEN": "ntn_paste_your_token_here"
      }
    }
  }
}
```

**Build locally instead:**

```bash
git clone https://github.com/awkoy/notion-mcp-server.git
cd notion-mcp-server
docker build -t notion-mcp-server .
# then swap `ghcr.io/awkoy/notion-mcp-server:latest` for `notion-mcp-server` above
```

**Docker Compose** (for local dev with both env vars):

```bash
NOTION_TOKEN=ntn_xxx NOTION_PAGE_ID=abc... docker compose run --rm notion-mcp-server
```

**Other container runtimes:** the published image is OCI-compliant, so it works with **Podman** (`podman run --rm -i ...`), **OrbStack**, **colima**, **Rancher Desktop**, **Finch**, and **nerdctl** — substitute the runtime's CLI for `docker` and the flags are identical. Docker Desktop is not required.

### Optional: `NOTION_PAGE_ID`

A default parent page used by `create_page` / `create_database` when the caller doesn't pass one. Operations that need a parent and don't get one now return a clear validation error instead of crashing the server.

To find a page ID: open the page in Notion → **Share → Copy link**. The ID is the last 32 characters of the URL.

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_xxx \
  -e NOTION_PAGE_ID=abc123... \
  -- node /absolute/path/to/notion-mcp-server/build/index.js
```

### Cursor / Claude Desktop

Add this entry to your MCP config JSON (`~/.cursor/mcp.json` for Cursor, `~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "notion": {
      "command": "node",
      "args": ["/absolute/path/to/notion-mcp-server/build/index.js"],
      "env": {
        "NOTION_TOKEN": "ntn_paste_your_token_here"
      }
    }
  }
}
```

## 🌟 Features

- **Two-tool surface** — `notion_execute` (do something) and `notion_describe` (learn its schema). No more 50-field union to load into the LLM's context.
- **Self-healing errors** — every validation failure returns `{ schema, example, fix }`, so the model corrects bad payloads in one round-trip.
- **Universal batch** — any mutating op accepts `{ items: [...], atomic?, idempotency_key?, concurrency? }` and reports per-item success/failure.
- **Atomic batches with rollback** — `atomic: true` aborts on first failure and best-effort archives anything created earlier in the batch.
- **Idempotency keys** — same key + same op = cached result. Safe to retry on flaky networks.
- **Markdown shortcut** — `create_page` / `append_blocks` / `update_block` accept a `markdown` string and convert it to Notion blocks (paragraphs, headings, lists, to-dos, quotes, code, dividers, images, inline annotations, links).
- **Slim responses by default** — pass `verbose: true` per call to get the raw Notion SDK shape.
- **32 operations** covering pages, blocks, databases, data sources, comments, and users — see `notion://operations`.
- **Universal MCP compatibility** — works with Cursor, Claude Desktop, Claude Code, Cline, Zed, etc.

## 📚 Documentation

### Available Tools

The v2 server exposes exactly **two** tools:

#### `notion_execute`

Run any Notion operation. Pass an operation name plus a payload — either a single object, or `{ items: [...] }` for batch mode.

**Single call:**

```jsonc
{
  "operation": "set_page_title",
  "payload": { "page_id": "<page-id>", "title": "Q3 plan" }
}
```

**Batch:**

```jsonc
{
  "operation": "set_page_title",
  "payload": {
    "items": [
      { "page_id": "<p1>", "title": "First" },
      { "page_id": "<p2>", "title": "Second" }
    ],
    "atomic": false,
    "concurrency": 3,
    "idempotency_key": "rename-pass-2025-05-26"
  }
}
```

**Markdown shortcut** (works in `create_page`, `append_blocks`, and `update_block`):

```jsonc
{
  "operation": "create_page",
  "payload": {
    "parent": { "type": "page_id", "page_id": "<parent>" },
    "title": "Notes",
    "markdown": "# Heading\n\n- [ ] todo\n- [x] done\n\n```ts\nconst x = 1;\n```"
  }
}
```

**Self-healing errors:** if the payload doesn't validate, the response includes the full JSON Schema for that operation plus a working example, so the next call can be corrected without round-tripping through `notion_describe`.

#### `notion_describe`

Return the JSON Schema + working example for a single operation. Use this when you want to see the shape of a complex op (filter expressions, mixed block batches, full database property definitions) before calling `notion_execute`.

```jsonc
{ "operation": "query_database" }
```

### Operations menu

Thirty-two operations cover the standard CRUD surface:

| Area         | Operations |
| ------------ | ---------- |
| Pages        | `create_page`, `get_page`, `set_page_title`, `set_page_property`, `set_page_properties`, `archive_page`, `restore_page`, `search_pages`, `move_page`, `get_page_markdown`, `update_page_markdown` |
| Blocks       | `append_blocks`, `get_block`, `get_block_children`, `update_block`, `delete_block`, `batch_mixed_blocks` |
| Databases    | `create_database`, `query_database`, `update_database` |
| Data sources | `list_data_sources`, `get_data_source`, `update_data_source` |
| Comments     | `list_comments`, `add_page_comment`, `add_discussion_comment`, `get_comment`, `update_comment`, `delete_comment` |
| Users        | `list_users`, `get_user`, `get_bot_user` |

The authoritative list (with batchability) is also served as an MCP resource at `notion://operations` — useful as a one-shot cheat sheet for the LLM.

### Available Resources

- **`notion://operations`** — Markdown table of every operation, with its batchability and one-line description. The LLM can read this resource once to know exactly what it can call without consuming context on per-op tool definitions.

## 🛠 Development

1. **Clone the Repository**
   ```
   git clone https://github.com/awkoy/notion-mcp-server.git
   cd notion-mcp-server
   ```

2. **Install Dependencies**
   ```
   npm install
   ```

3. **Set Up Environment Variables**
   - Create a `.env` file with:
     ```
     NOTION_TOKEN=your_notion_api_key
     NOTION_PAGE_ID=your_notion_page_id
     ```

4. **Build the Project**
   ```
   npm run build
   ```

5. **Run the Inspector**
   ```
   npm run inspector
   ```

## 🔧 Technical Details

- Built using TypeScript and the MCP SDK (^1.29.0)
- Uses the official Notion API client (@notionhq/client ^2.3.0)
- Follows the Model Context Protocol specification
- Validates payloads with Zod 4 and emits draft-7 JSON Schema (with `$defs` deduplication) for error envelopes
- Markdown → Notion blocks conversion via the remark / remark-gfm pipeline
- Bounded-concurrency batch worker pool (default 3, max 10)
- In-memory idempotency cache (5-minute TTL, 512 entries)
- Vitest smoke harness covering the markdown parser, slim shapers, schema emitter, and dispatcher (`npm test`)

## ❓ Troubleshooting

- **"object_not_found" / "Could not find ..."** — the integration token can only see pages explicitly shared with it. Switch to a PAT (Option 1) to skip per-page sharing.
- **"Notion auth failed: ..." on every call** — the token was missing, revoked, or rejected. Check `NOTION_TOKEN` is set in your MCP client config, and verify the token is still listed under Notion → Settings → My Settings → Personal Access Tokens (or Settings → Connections → Develop or manage integrations).
- **"No parent page configured"** — pass `parent` in the call, or set `NOTION_PAGE_ID` to a default.
- **Server logs "Notion auth check failed" on startup but tools still work** — the startup check is best-effort. If subsequent tool calls succeed, ignore the warning (Claude Code suppresses MCP stderr in normal operation anyway).
- **Docker container exits immediately / "Connection closed"** — the `-i` flag is required so Docker keeps stdin open for the MCP stdio transport. `docker run --rm -i ...`, not `docker run --rm ...`.
- **Docker: "NOTION_TOKEN is not set" despite passing `-e`** — make sure the form is `-e NOTION_TOKEN` (forwards from parent env) or `-e NOTION_TOKEN=ntn_xxx` (inline value), not `-e NOTION_TOKEN ntn_xxx` (treated as two separate args).

### Getting Help

- Create an issue on the [GitHub repository](https://github.com/awkoy/notion-mcp-server/issues)
- Check the [Notion API documentation](https://developers.notion.com/reference/intro)
- Visit the MCP community channels for assistance

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

