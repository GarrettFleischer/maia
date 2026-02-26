/**
 * @fileoverview Embedding refresh: indexes any history entries not yet present in history_vectors.
 * Called before the heartbeat wakes agents so that semantic search operates on current data.
 * @module lib/knowledge/refresh-embeddings
 *
 * @note Only history entries are refreshed here. Knowledge documents are indexed separately
 * (e.g. by the knowledge-index tool or manual trigger). This module is designed to be fast
 * and non-blocking: failures are logged and never propagate.
 * Long entries are chunked using the model's context length so embedding never exceeds limits.
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
 * Finds all history entries that have no corresponding row in history_vectors and embeds them.
 * Uses Ollama context length when available to avoid "input length exceeds context length" errors.
 * Long content is chunked and stored as multiple vectors per entry.
 * Safe to call multiple times; already-indexed entries are skipped.
 * Logs errors and resolves (never rejects) so callers can fire-and-await safely.
 * @param ctx - Application context
 */
export async function refreshEmbeddings(ctx: AppContext): Promise<void> {
  const settings = getSettings(ctx);
  const maxLen = await getEffectiveEmbedMaxLength(settings, ctx.http);

  // Find history entries not yet in history_vectors
  const unindexed = ctx.db
    .prepare(
      `SELECT he.id, he.session_id, he.content, he.is_compressed
       FROM history_entries he
       LEFT JOIN history_vectors hv ON hv.entry_id = he.id
       WHERE hv.id IS NULL AND he.content != ''`
    )
    .all() as { id: string; session_id: string; content: string; is_compressed: number }[];

  if (unindexed.length === 0) return;

  const embedder = createEmbeddingAdapter(settings, ctx.http);
  const store = createVectorStore(ctx.db);
  const { v4: uuidv4 } = await import("uuid");
  const now = new Date().toISOString();

  for (const row of unindexed) {
    try {
      const chunks = chunkContentForEmbedding(row.content, maxLen);
      for (const chunk of chunks) {
        const embedding = await embedder.embed(chunk);
        store.insertHistory(
          uuidv4(),
          row.session_id,
          row.id,
          chunk,
          embedding,
          row.is_compressed === 1,
          now,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[refreshEmbeddings] Failed to index entry ${row.id}:`, msg);
    }
  }
}
