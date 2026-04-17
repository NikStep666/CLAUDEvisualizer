import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "..", "data", "visualizer.db");

// Ensure data directory exists
const dataDir = join(import.meta.dir, "..", "data");
try { await Bun.write(join(dataDir, ".keep"), ""); } catch {}

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS visualizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    format TEXT NOT NULL CHECK(format IN ('markdown', 'html', 'terminal')),
    title TEXT,
    panel TEXT,
    tags TEXT DEFAULT '[]',
    content_preview TEXT,
    content_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_viz_created ON visualizations(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_viz_format ON visualizations(format);
  CREATE INDEX IF NOT EXISTS idx_viz_hash ON visualizations(content_hash);
`);

// FTS5 full-text search index
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS viz_fts USING fts5(
    title,
    content,
    tags,
    content='visualizations',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  -- Triggers to keep FTS in sync
  CREATE TRIGGER IF NOT EXISTS viz_ai AFTER INSERT ON visualizations BEGIN
    INSERT INTO viz_fts(rowid, title, content, tags)
    VALUES (new.id, new.title, new.content, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS viz_ad AFTER DELETE ON visualizations BEGIN
    INSERT INTO viz_fts(viz_fts, rowid, title, content, tags)
    VALUES ('delete', old.id, old.title, old.content, old.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS viz_au AFTER UPDATE ON visualizations BEGIN
    INSERT INTO viz_fts(viz_fts, rowid, title, content, tags)
    VALUES ('delete', old.id, old.title, old.content, old.tags);
    INSERT INTO viz_fts(rowid, title, content, tags)
    VALUES (new.id, new.title, new.content, new.tags);
  END;
`);

// --- Helpers ---
function hashContent(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex").slice(0, 16);
}

function preview(content: string, maxLen = 200): string {
  return content.replace(/[#*`\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function autoTags(content: string, format: string, title?: string): string[] {
  const tags: string[] = [format];
  if (/\$\$?[^$]+\$\$?/.test(content)) tags.push("math");
  if (/```mermaid/i.test(content)) tags.push("diagram");
  if (/Plotly\.newPlot|plotly/i.test(content)) tags.push("chart");
  if (/d3\.select|d3\./.test(content)) tags.push("d3");
  if (/```\w+/.test(content)) tags.push("code");
  if (/\|.*\|.*\|/.test(content)) tags.push("table");
  if (title) tags.push(...title.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  return [...new Set(tags)];
}

// --- CRUD ---
export type Visualization = {
  id: number;
  content: string;
  format: string;
  title: string | null;
  panel: string | null;
  tags: string;
  content_preview: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
};

const insertStmt = db.prepare(`
  INSERT INTO visualizations (content, format, title, panel, tags, content_preview, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const updateStmt = db.prepare(`
  UPDATE visualizations SET content = ?, format = ?, title = ?, tags = ?, content_preview = ?, content_hash = ?, updated_at = datetime('now')
  WHERE id = ?
`);

export function save(
  content: string,
  format: string,
  title?: string,
  panel?: string,
): number {
  const hash = hashContent(content);
  const tags = JSON.stringify(autoTags(content, format, title));
  const prev = preview(content);

  // Dedup: if exact same content exists recently (last 5 min), skip
  const existing = db.prepare(
    "SELECT id FROM visualizations WHERE content_hash = ? AND created_at > datetime('now', '-5 minutes')"
  ).get(hash) as { id: number } | null;

  if (existing) return existing.id;

  const result = insertStmt.run(content, format, title || null, panel || null, tags, prev, hash);
  return Number(result.lastInsertRowid);
}

export function getById(id: number): Visualization | null {
  return db.prepare("SELECT * FROM visualizations WHERE id = ?").get(id) as Visualization | null;
}

export function history(limit = 20, offset = 0, format?: string): Visualization[] {
  if (format) {
    return db.prepare(
      "SELECT * FROM visualizations WHERE format = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(format, limit, offset) as Visualization[];
  }
  return db.prepare(
    "SELECT * FROM visualizations ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).all(limit, offset) as Visualization[];
}

export function search(query: string, limit = 10): Visualization[] {
  // FTS5 search with ranking
  return db.prepare(`
    SELECT v.*, rank
    FROM viz_fts fts
    JOIN visualizations v ON v.id = fts.rowid
    WHERE viz_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as Visualization[];
}

export function count(): number {
  return (db.prepare("SELECT COUNT(*) as c FROM visualizations").get() as { c: number }).c;
}

// --- BOARDS ---
db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    panels TEXT NOT NULL,
    edges TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

export type Board = {
  id: number;
  name: string;
  description: string | null;
  panels: string;
  edges: string;
  created_at: string;
};

export type BoardPanel = {
  panel: string;
  title: string;
  format: string;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BoardEdge = {
  from: string;
  to: string;
  label?: string;
  color?: string;
};

export function saveBoard(
  name: string,
  panels: BoardPanel[],
  edges: BoardEdge[],
  description?: string,
): number {
  const result = db.prepare(
    "INSERT INTO boards (name, description, panels, edges) VALUES (?, ?, ?, ?)"
  ).run(name, description || null, JSON.stringify(panels), JSON.stringify(edges));
  return Number(result.lastInsertRowid);
}

export function getBoard(id: number): Board | null {
  return db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as Board | null;
}

export function listBoards(limit = 20): Board[] {
  return db.prepare(
    "SELECT id, name, description, created_at FROM boards ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as Board[];
}

export function boardCount(): number {
  return (db.prepare("SELECT COUNT(*) as c FROM boards").get() as { c: number }).c;
}

console.error(`[visualizer] database at ${DB_PATH} (${count()} visualizations, ${boardCount()} boards)`);
