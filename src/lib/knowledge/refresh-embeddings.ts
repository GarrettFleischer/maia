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
        await embedOneChunk(
          embedder,
          store,
          chunk,
          maxLen,
          row.session_id,
          row.id,
          row.is_compressed === 1,
          now,
          uuidv4,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[refreshEmbeddings] Failed to index entry ${row.id}:`, msg);
    }
  }
}

/**
 * Embeds one chunk and inserts into the store. On "context length" error, retries once
 * with half-sized sub-chunks so we stay under the embed API limit.
 * @param embedder - Embedding adapter
 * @param store - Vector store
 * @param chunk - Text to embed
 * @param maxLen - Current max character length per chunk
 * @param sessionId - Session ID for the entry
 * @param entryId - Entry ID
 * @param isCompressed - Whether the entry is compressed
 * @param now - Timestamp string
 * @param uuidv4 - UUID v4 function
 */
async function embedOneChunk(
  embedder: ReturnType<typeof createEmbeddingAdapter>,
  store: ReturnType<typeof createVectorStore>,
  chunk: string,
  maxLen: number,
  sessionId: string,
  entryId: string,
  isCompressed: boolean,
  now: string,
  uuidv4: () => string,
): Promise<void> {
  try {
    const embedding = await embedder.embed(chunk);
    store.insertHistory(uuidv4(), sessionId, entryId, chunk, embedding, isCompressed, now);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isContextLengthError = /context length|exceeds the context length/i.test(msg);
    const smallerMax = Math.floor(maxLen / 2);
    if (isContextLengthError && smallerMax >= 1) {
      const subChunks = chunkContentForEmbedding(chunk, smallerMax);
      for (const sub of subChunks) {
        try {
          const embedding = await embedder.embed(sub);
          store.insertHistory(uuidv4(), sessionId, entryId, sub, embedding, isCompressed, now);
        } catch (subErr) {
          const subMsg = subErr instanceof Error ? subErr.message : String(subErr);
          console.error(`[refreshEmbeddings] Failed to index entry ${entryId} (sub-chunk):`, subMsg);
        }
      }
    } else {
      console.error(`[refreshEmbeddings] Failed to index entry ${entryId}:`, msg);
    }
  }
}
