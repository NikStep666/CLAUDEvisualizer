# CLAUDEvisualizer

MCP server that renders HTML/visualizations in a browser window.

## Stack
- Runtime: Bun (TypeScript, no build step)
- MCP: @modelcontextprotocol/sdk (McpServer, stdio transport)
- Browser: CDN libraries (marked, KaTeX, Mermaid, Plotly, D3, highlight.js)

## Architecture

Single Bun process:
1. MCP stdio transport (tool calls from Claude Code)
2. Bun.serve() HTTP + WebSocket on port 7331

## Run

```bash
bun run src/index.ts
```

## Files
- `src/index.ts` — MCP server + tool definitions (visualize, clear, recall, re_render, history)
- `src/server.ts` — Bun.serve() HTTP + WebSocket + browser opening
- `src/viewer.html` — Browser frontend (self-contained, CDN libs)
- `src/db.ts` — SQLite storage + FTS5 full-text search (bun:sqlite)
- `src/qdrant.ts` — Qdrant vector search (semantic recall, 384-dim bge-small-en-v1.5)

## Port
Default 7331, override via `VISUALIZER_PORT` env var.

## Viewer Modes

**Scroll** — Classic vertical scroll layout (max-width 900px). Default.

**Board** — Infinite canvas with zoom/pan. Content renders as floating, draggable panels. Mouse wheel zooms, drag pans, double-click resets. Toggle via toolbar.

## Formats

| Format | Use |
|--------|-----|
| `markdown` | Markdown with KaTeX math and ```mermaid diagrams (default) |
| `html` | Raw HTML with script execution, Plotly/D3 globals available |
| `terminal` | Styled command output ($ prefix = command, ERROR: = red, etc.) |

## Panel System (Board Mode)

Each `visualize` call creates a floating panel. Use the `panel` parameter with a stable ID to update an existing panel instead of creating a new one.
