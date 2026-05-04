/**
 * @fileoverview Index a single history entry for semantic search in SQLite history_vectors.
 * @module lib/knowledge/history-index
 *
 * Writes to the SQLite history_vectors table using the configured embedder.
 * Called fire-and-forget after appending entries (original and compressed).
 */

import { getSettings } from "../settings";
import {
  createEmbeddingAdapter,
  getEffectiveEmbedMaxLength,
  chunkContentForEmbedding,
} from "./embedding";
import { createVectorStore } from "./vector-store";
import type { AppContext } from "../context";

/**
 * @brief Load an entry from history_entries and write embeddings to the vector store.
 * @param ctx Application context
 * @param entryId History entry id
 * @note Safe to call fire-and-forget; logs errors and does not throw.
 */
export async function indexHistoryEntry(
  ctx: AppContext,
  entryId: string,
): Promise<void> {
  const row = ctx.db
    .prepare(
      "SELECT id, session_id, role, content, tool_name, tool_args, timestamp, is_compressed FROM history_entries WHERE id = ?",
    )
    .get(entryId) as
    | {
        id: string;
        session_id: string;
        content: string;
        is_compressed: number;
      }
    | undefined;

  if (!row) return;

  const role = (row as { role?: string }).role;
  if (role === "smart_context") return;
  if (role === "thinking") return;
  if (row.content.trim() === "") return;

  try {
    const settings = getSettings(ctx);
    const maxChars = await getEffectiveEmbedMaxLength(settings, ctx.http);
    const chunks = chunkContentForEmbedding(row.content, maxChars);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    const store = createVectorStore(ctx.db);
    const createdAt =
      (row as { timestamp?: string }).timestamp ?? new Date().toISOString();
    const vectorId =
      row.is_compressed === 1 ? `${row.id}-compressed` : row.id;
    store.deleteHistoryByEntryId(row.id);
    const embedBatch =
      embedder.embedBatch ??
      (async (texts: string[]) => {
        const out: number[][] = [];
        for (const text of texts) out.push(await embedder.embed(text));
        return out;
      });
    const embeddings = await embedBatch(chunks);
    for (let i = 0; i < chunks.length; i++) {
      const chunkId =
        chunks.length === 1 ? vectorId : `${vectorId}-chunk-${i}`;
      store.insertHistory(
        chunkId,
        row.session_id,
        row.id,
        chunks[i],
        embeddings[i],
        row.is_compressed === 1,
        createdAt,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("History vector write skipped:", msg, entryId);
  }
}
