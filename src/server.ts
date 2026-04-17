import type { ServerWebSocket } from "bun";
import { join } from "path";

const PORT = parseInt(process.env.VISUALIZER_PORT || "7331");

let browserOpened = false;

// Callback for board state responses from browser
let boardStateResolver: ((data: any) => void) | null = null;
export function waitForBoardState(timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    boardStateResolver = resolve;
    setTimeout(() => { boardStateResolver = null; reject(new Error("timeout")); }, timeout);
  });
}
let contentBuffer = "";
let lastFormat: "markdown" | "html" | "terminal" = "markdown";
let lastTitle = "";
const edgeCache: ConnectMessage[] = [];

import * as db from "./db.ts";

const viewerHtml = await Bun.file(join(import.meta.dir, "viewer.html")).text();

export type RenderMessage = {
  type: "render";
  content: string;
  format: "markdown" | "html" | "terminal";
  title?: string;
  append?: boolean;
  panel?: string;
  x?: number;
  y?: number;
  width?: number;
};

export type ClearMessage = {
  type: "clear";
};

export type ConnectMessage = {
  type: "connect";
  from: string;
  to: string;
  label?: string;
  color?: string;
  id?: string;
};

export type SaveBoardRequest = {
  type: "request_board_state";
  name: string;
  description?: string;
};

export type LoadBoardMessage = {
  type: "load_board";
  panels: Array<{ panel: string; title: string; format: string; content: string; x: number; y: number; width: number; height: number }>;
  edges: Array<{ from: string; to: string; label?: string; color?: string }>;
};

export type WsMessage = RenderMessage | ClearMessage | ConnectMessage | SaveBoardRequest | LoadBoardMessage;

export function publish(message: WsMessage) {
  if (message.type === "render") {
    if (message.append) {
      contentBuffer += "\n" + message.content;
    } else {
      contentBuffer = message.content;
    }
    lastFormat = message.format;
    if (message.title) lastTitle = message.title;
  } else if (message.type === "clear") {
    contentBuffer = "";
    lastTitle = "";
    lastFormat = "markdown";
    edgeCache.length = 0;
  } else if (message.type === "connect") {
    const id = message.id || `${message.from}-${message.to}`;
    // Replace existing edge with same id
    const idx = edgeCache.findIndex(e => (e.id || `${e.from}-${e.to}`) === id);
    if (idx >= 0) edgeCache[idx] = message;
    else edgeCache.push(message);
  }

  const payload = JSON.stringify(message);
  server.publish("viz", payload);
}

export function openBrowser() {
  if (browserOpened) return;
  browserOpened = true;
  Bun.spawn(["xdg-open", `http://localhost:${PORT}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

const server = Bun.serve<{}>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/api/boards") {
      const boards = db.listBoards(50);
      return new Response(JSON.stringify(boards), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(viewerHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },

  websocket: {
    open(ws: ServerWebSocket<{}>) {
      ws.subscribe("viz");
      if (contentBuffer) {
        ws.send(
          JSON.stringify({
            type: "render",
            content: contentBuffer,
            format: lastFormat,
            title: lastTitle || undefined,
            append: false,
          })
        );
      }
      for (const edge of edgeCache) {
        ws.send(JSON.stringify(edge));
      }
    },
    close(ws: ServerWebSocket<{}>) {
      ws.unsubscribe("viz");
    },
    message(_ws, msg) {
      try {
        const data = JSON.parse(String(msg));
        if (data.type === "board_state" && boardStateResolver) {
          boardStateResolver(data);
          boardStateResolver = null;
        } else if (data.type === "board_state" && data.name) {
          // Direct save from browser UI (Save button)
          const id = db.saveBoard(data.name, data.panels || [], data.edges || [], data.description);
          console.error(`[visualizer] board saved: #${id} "${data.name}"`);
        } else if (data.type === "load_board_request" && data.id) {
          // Load request from browser UI
          const board = db.getBoard(data.id);
          if (board) {
            const panels = JSON.parse(board.panels);
            const edges = JSON.parse(board.edges);
            // Clear first
            publish({ type: "clear" });
            setTimeout(() => {
              for (const p of panels) {
                publish({ type: "render", content: p.content, format: p.format, title: p.title, panel: p.panel, x: p.x, y: p.y, width: p.width, append: false });
              }
              for (const e of edges) {
                publish({ type: "connect", from: e.from, to: e.to, label: e.label, color: e.color });
              }
            }, 100);
          }
        }
      } catch {}
    },
  },
});

console.error(`[visualizer] listening on http://localhost:${PORT}`);
