import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { publish, openBrowser, waitForBoardState } from "./server.ts";
import * as db from "./db.ts";
import { initQdrant, upsert, semanticSearch } from "./qdrant.ts";

// Init Qdrant in background — don't block MCP handshake
let qdrantAvailable = false;
initQdrant().then(ok => { qdrantAvailable = ok; }).catch(() => {});

const server = new McpServer({
  name: "claude-visualizer",
  version: "1.0.0",
});

server.tool(
  "visualize",
  "Render content in a browser window. Use this to visually communicate with the user: math formulas, diagrams, charts, terminal output, or any HTML. The viewer has two modes: Scroll (classic vertical) and Board (infinite canvas with floating panels, zoom/pan). The browser tab opens automatically on first call.\n\nFormats:\n- markdown: Markdown with KaTeX math ($...$, $$...$$) and ```mermaid diagram blocks\n- html: Raw HTML with script execution, Plotly/D3 available as globals\n- terminal: Styled command output display (lines starting with '$ ' get command styling, 'ERROR:' gets red, etc.)\n\nIn Board mode, each call creates a new floating panel (or updates an existing one via the panel parameter). Panels are draggable.",
  {
    content: z.string().describe("The content to render. Markdown: $...$ for inline math, $$...$$ for display math, ```mermaid for diagrams. HTML: full control. Terminal: prefix lines with '$ ' for commands, plain text for output."),
    format: z.enum(["markdown", "html", "terminal"]).default("markdown").describe("'markdown' for Markdown/KaTeX/Mermaid, 'html' for raw HTML, 'terminal' for styled command output"),
    title: z.string().optional().describe("Panel/page title"),
    append: z.boolean().default(false).describe("Append to existing content instead of replacing it"),
    panel: z.string().optional().describe("Panel ID for Board mode. Same ID updates the same panel. Omit for auto-ID."),
    x: z.number().optional().describe("Board mode: explicit X position (px). Use with y to place panels in a meaningful graph layout."),
    y: z.number().optional().describe("Board mode: explicit Y position (px). Use with x to place panels in a meaningful graph layout."),
    width: z.number().optional().describe("Panel width in px (default: 700, terminal: 600)"),
  },
  async ({ content, format, title, append, panel, x, y, width }) => {
    publish({ type: "render", content, format, title, append, panel, x, y, width });
    openBrowser();

    // Auto-save to SQLite
    const id = db.save(content, format, title, panel);

    // Async save to Qdrant (non-blocking)
    if (qdrantAvailable) {
      const tags = JSON.parse(
        db.getById(id)?.tags || "[]"
      );
      upsert(id, content, format, title, tags).catch(() => {});
    }

    return {
      content: [
        {
          type: "text",
          text: `Rendered in browser (${format}, ${content.length} chars${append ? ", appended" : ""}${panel ? ", panel=" + panel : ""}, saved #${id})`,
        },
      ],
    };
  }
);

server.tool(
  "clear",
  "Clear all content from the browser viewer window.",
  {},
  async () => {
    publish({ type: "clear" });
    return {
      content: [{ type: "text", text: "Viewer cleared" }],
    };
  }
);

server.tool(
  "recall",
  "Search past visualizations by keyword (FTS) or semantically (Qdrant). Use this to find and re-render previous content.",
  {
    query: z.string().describe("Search query — keywords or natural language description of what you're looking for"),
    method: z.enum(["auto", "fts", "semantic"]).default("auto").describe("Search method: 'fts' for keyword search, 'semantic' for Qdrant vector search, 'auto' tries semantic first then FTS"),
    limit: z.number().default(5).describe("Max results to return"),
    format: z.string().optional().describe("Filter by format: markdown, html, terminal"),
  },
  async ({ query, method, limit, format }) => {
    let results: Array<{ id: number; title: string | null; format: string; preview: string; score?: number; created_at: string }> = [];

    // Semantic search via Qdrant
    if ((method === "auto" || method === "semantic") && qdrantAvailable) {
      const qdrantResults = await semanticSearch(query, limit, format);
      results = qdrantResults.map(r => ({
        id: r.payload.sqlite_id,
        title: r.payload.title,
        format: r.payload.format,
        preview: r.payload.content_preview,
        score: r.score,
        created_at: r.payload.created_at,
      }));
    }

    // FTS fallback (or if method is "fts")
    if (results.length === 0 || method === "fts") {
      const ftsResults = db.search(query, limit);
      results = ftsResults.map(r => ({
        id: r.id,
        title: r.title,
        format: r.format,
        preview: r.content_preview || "",
        created_at: r.created_at,
      }));
    }

    if (results.length === 0) {
      return { content: [{ type: "text", text: "No matching visualizations found." }] };
    }

    const text = results.map((r, i) =>
      `${i + 1}. [#${r.id}] ${r.title || "(untitled)"} (${r.format}) — ${r.created_at}${r.score ? ` [score: ${r.score.toFixed(3)}]` : ""}\n   ${r.preview}`
    ).join("\n\n");

    return {
      content: [{ type: "text", text: `Found ${results.length} results:\n\n${text}\n\nUse re_render with the ID to show it again.` }],
    };
  }
);

server.tool(
  "re_render",
  "Re-render a previously saved visualization by its ID.",
  {
    id: z.number().describe("The visualization ID from recall/history results"),
  },
  async ({ id }) => {
    const viz = db.getById(id);
    if (!viz) {
      return { content: [{ type: "text", text: `Visualization #${id} not found.` }] };
    }

    publish({
      type: "render",
      content: viz.content,
      format: viz.format as "markdown" | "html" | "terminal",
      title: viz.title || undefined,
      append: false,
    });
    openBrowser();

    return {
      content: [{ type: "text", text: `Re-rendered #${id}: ${viz.title || "(untitled)"} (${viz.format})` }] };
  }
);

server.tool(
  "history",
  "List recent visualizations. Returns IDs, titles, formats, and timestamps.",
  {
    limit: z.number().default(10).describe("Number of recent entries to show"),
    format: z.string().optional().describe("Filter by format: markdown, html, terminal"),
  },
  async ({ limit, format }) => {
    const items = db.history(limit, 0, format);

    if (items.length === 0) {
      return { content: [{ type: "text", text: "No visualizations saved yet." }] };
    }

    const total = db.count();
    const text = items.map((r, i) =>
      `${i + 1}. [#${r.id}] ${r.title || "(untitled)"} (${r.format}) — ${r.created_at}\n   ${r.content_preview || ""}`
    ).join("\n\n");

    return {
      content: [{ type: "text", text: `${total} total visualizations. Showing last ${items.length}:\n\n${text}` }],
    };
  }
);

server.tool(
  "connect",
  "Draw a labeled edge between two panels in Board mode. Creates a directed arrow from one panel to another with an optional label. Edges update automatically when panels are dragged or resized.",
  {
    from: z.string().describe("Source panel ID"),
    to: z.string().describe("Target panel ID"),
    label: z.string().optional().describe("Edge label (e.g. 'state estimate', 'cmd_vel', 'HTTP')"),
    color: z.string().optional().describe("Edge color (CSS color, default: cyan)"),
  },
  async ({ from, to, label, color }) => {
    publish({ type: "connect", from, to, label, color });
    return {
      content: [{ type: "text", text: `Edge: ${from} → ${to}${label ? ` [${label}]` : ""}` }],
    };
  }
);

server.tool(
  "save_board",
  "Save the current board state (all panels with positions + all edges) as a named snapshot. The browser sends back the current state including any manual repositioning.",
  {
    name: z.string().describe("Name for this board snapshot (e.g. 'SNN Robotics Architecture')"),
    description: z.string().optional().describe("Optional description"),
  },
  async ({ name, description }) => {
    // Ask browser for current state
    publish({ type: "request_board_state", name, description });
    try {
      const state = await waitForBoardState();
      const id = db.saveBoard(name, state.panels || [], state.edges || [], description);
      return {
        content: [{ type: "text", text: `Board saved as #${id}: "${name}" (${(state.panels || []).length} panels, ${(state.edges || []).length} edges)` }],
      };
    } catch {
      return {
        content: [{ type: "text", text: "Failed to save board — browser did not respond. Is the viewer tab open?" }],
      };
    }
  }
);

server.tool(
  "load_board",
  "Load a previously saved board snapshot by ID. Clears the current view and restores all panels and edges.",
  {
    id: z.number().describe("Board ID from list_boards"),
  },
  async ({ id }) => {
    const board = db.getBoard(id);
    if (!board) {
      return { content: [{ type: "text", text: `Board #${id} not found.` }] };
    }

    const panels = JSON.parse(board.panels);
    const edges = JSON.parse(board.edges);

    // Clear and rebuild
    publish({ type: "clear" });

    // Small delay then send panels and edges
    await new Promise(r => setTimeout(r, 100));

    for (const p of panels) {
      publish({
        type: "render",
        content: p.content,
        format: p.format,
        title: p.title,
        panel: p.panel,
        x: p.x,
        y: p.y,
        width: p.width,
        append: false,
      });
    }

    for (const e of edges) {
      publish({ type: "connect", from: e.from, to: e.to, label: e.label, color: e.color });
    }

    openBrowser();
    return {
      content: [{ type: "text", text: `Board "${board.name}" loaded (${panels.length} panels, ${edges.length} edges)` }],
    };
  }
);

server.tool(
  "list_boards",
  "List all saved board snapshots.",
  {
    limit: z.number().default(10).describe("Max results"),
  },
  async ({ limit }) => {
    const boards = db.listBoards(limit);
    if (boards.length === 0) {
      return { content: [{ type: "text", text: "No boards saved yet." }] };
    }
    const text = boards.map((b, i) =>
      `${i + 1}. [#${b.id}] ${b.name}${b.description ? ' — ' + b.description : ''} (${b.created_at})`
    ).join("\n");
    return {
      content: [{ type: "text", text: `${boards.length} boards:\n\n${text}` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[visualizer] MCP server connected via stdio");
