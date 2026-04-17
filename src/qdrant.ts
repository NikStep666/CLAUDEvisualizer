const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6335";
const COLLECTION = "visualizer_history";
const VECTOR_DIM = 384;

// --- Collection Setup ---
async function ensureCollection(): Promise<boolean> {
  try {
    const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`);
    if (resp.ok) return true;

    // Create collection
    const createResp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: VECTOR_DIM, distance: "Cosine" },
        optimizers_config: { indexing_threshold: 100 },
      }),
    });

    if (!createResp.ok) {
      console.error(`[qdrant] failed to create collection: ${await createResp.text()}`);
      return false;
    }

    // Create payload indexes for filtering
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_name: "format", field_schema: "keyword" }),
    });
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_name: "created_at", field_schema: "datetime" }),
    });
    await fetch(`${QDRANT_URL}/collections/${COLLECTION}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_name: "tags", field_schema: "keyword" }),
    });

    console.error(`[qdrant] collection '${COLLECTION}' created`);
    return true;
  } catch (e) {
    console.error(`[qdrant] not available: ${(e as Error).message}`);
    return false;
  }
}

let qdrantReady = false;

export async function initQdrant(): Promise<boolean> {
  qdrantReady = await ensureCollection();
  return qdrantReady;
}

// --- Embeddings via fastembed subprocess ---
async function embed(text: string): Promise<number[] | null> {
  try {
    // Truncate to ~500 chars for embedding (title + preview)
    const truncated = text.slice(0, 500).replace(/'/g, "\\'").replace(/\n/g, " ");

    const proc = Bun.spawn([
      "uv", "run", "--with", "fastembed", "python3", "-c",
      `from fastembed import TextEmbedding; import json; m=TextEmbedding('BAAI/bge-small-en-v1.5'); v=list(m.embed(['${truncated}']))[0]; print(json.dumps(v.tolist()))`,
    ], { stdout: "pipe", stderr: "ignore" });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return null;
    return JSON.parse(output.trim());
  } catch (e) {
    console.error(`[qdrant] embedding failed: ${(e as Error).message}`);
    return null;
  }
}

// --- Upsert ---
export async function upsert(
  sqliteId: number,
  content: string,
  format: string,
  title?: string,
  tags?: string[],
): Promise<boolean> {
  if (!qdrantReady) return false;

  const textToEmbed = [title || "", content.slice(0, 400)].join(" ").trim();
  const vector = await embed(textToEmbed);
  if (!vector) return false;

  try {
    const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [
          {
            id: sqliteId,
            vector,
            payload: {
              sqlite_id: sqliteId,
              format,
              title: title || null,
              tags: tags || [],
              content_preview: content.slice(0, 200).replace(/\n/g, " "),
              created_at: new Date().toISOString(),
            },
          },
        ],
      }),
    });

    return resp.ok;
  } catch (e) {
    console.error(`[qdrant] upsert failed: ${(e as Error).message}`);
    return false;
  }
}

// --- Semantic Search ---
export type QdrantResult = {
  id: number;
  score: number;
  payload: {
    sqlite_id: number;
    format: string;
    title: string | null;
    tags: string[];
    content_preview: string;
    created_at: string;
  };
};

export async function semanticSearch(
  query: string,
  limit = 5,
  formatFilter?: string,
): Promise<QdrantResult[]> {
  if (!qdrantReady) return [];

  const vector = await embed(query);
  if (!vector) return [];

  try {
    const filter = formatFilter
      ? { must: [{ key: "format", match: { value: formatFilter } }] }
      : undefined;

    const resp = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: vector,
        limit,
        filter,
        with_payload: true,
      }),
    });

    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.result?.points || []) as QdrantResult[];
  } catch (e) {
    console.error(`[qdrant] search failed: ${(e as Error).message}`);
    return [];
  }
}
