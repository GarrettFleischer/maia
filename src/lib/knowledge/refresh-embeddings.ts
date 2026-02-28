/**
 * @fileoverview Embedding refresh: indexes any history entries not yet present in history_vectors.
 * Called before the heartbeat wakes agents so that semantic search operates on current data.
 * @module lib/knowledge/refresh-embeddings
 *
 * @note Only history entries are refreshed here. Knowledge documents are indexed separately
 * (e.g. by the knowledge-index tool or manual trigger). Uses batch embedding when available
 * to reduce API round trips.
 */

import { getSettings } from "../settings";
import {
  createEmbeddingAdapter,
  getEffectiveEmbedMaxLength,
  chunkContentForEmbedding,
  EMBED_BATCH_SIZE,
} from "./embedding";
import { createVectorStore } from "./vector-store";
import type { AppContext } from "../context";

interface ChunkWithMeta {
  text: string;
  sessionId: string;
  entryId: string;
  isCompressed: boolean;
}

/**
 * Finds all history entries that have no corresponding row in history_vectors and embeds them.
 * Batches chunks into groups of EMBED_BATCH_SIZE when the adapter supports embedBatch.
 * Safe to call multiple times; already-indexed entries are skipped.
 * @param ctx - Application context
 */
export async function refreshEmbeddings(ctx: AppContext): Promise<void> {
  const settings = getSettings(ctx);
  const maxLen = await getEffectiveEmbedMaxLength(settings, ctx.http);

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

  const chunksWithMeta: ChunkWithMeta[] = [];
  for (const row of unindexed) {
    try {
      const chunks = chunkContentForEmbedding(row.content, maxLen);
      for (const chunk of chunks) {
        chunksWithMeta.push({
          text: chunk,
          sessionId: row.session_id,
          entryId: row.id,
          isCompressed: row.is_compressed === 1,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[refreshEmbeddings] Failed to chunk entry ${row.id}:`, msg);
    }
  }

  const totalChunks = chunksWithMeta.length;
  const totalEntries = unindexed.length;
  console.info(`[Embedding] Indexing ${totalEntries} history entries (${totalChunks} chunks)...`);

  const useBatch = typeof embedder.embedBatch === "function";

  if (useBatch) {
    for (let i = 0; i < chunksWithMeta.length; i += EMBED_BATCH_SIZE) {
      const batch = chunksWithMeta.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map((c) => c.text);
      try {
        const embeddings = await embedder.embedBatch!(texts);
        if (embeddings.length !== batch.length) {
          throw new Error(`Batch size mismatch: got ${embeddings.length}, expected ${batch.length}`);
        }
        for (let j = 0; j < batch.length; j++) {
          store.insertHistory(
            uuidv4(),
            batch[j].sessionId,
            batch[j].entryId,
            batch[j].text,
            embeddings[j],
            batch[j].isCompressed,
            now,
          );
        }
        const done = Math.min(i + EMBED_BATCH_SIZE, totalChunks);
        if (done % (EMBED_BATCH_SIZE * 4) === 0 || done === totalChunks) {
          console.info(`[Embedding] Progress: ${done}/${totalChunks} chunks indexed`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[refreshEmbeddings] Batch failed, falling back to sequential:`, msg);
        for (let j = 0; j < batch.length; j++) {
          try {
            await embedOneChunk(
              embedder,
              store,
              batch[j].text,
              maxLen,
              batch[j].sessionId,
              batch[j].entryId,
              batch[j].isCompressed,
              now,
              uuidv4,
            );
          } catch (chunkErr) {
            const chunkMsg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
            console.error(`[refreshEmbeddings] Failed to index entry ${batch[j].entryId}:`, chunkMsg);
          }
        }
      }
    }
  } else {
    for (let i = 0; i < chunksWithMeta.length; i++) {
      const c = chunksWithMeta[i];
      try {
        await embedOneChunk(embedder, store, c.text, maxLen, c.sessionId, c.entryId, c.isCompressed, now, uuidv4);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[refreshEmbeddings] Failed to index entry ${c.entryId}:`, msg);
      }
      if ((i + 1) % 50 === 0 || i + 1 === totalChunks) {
        console.info(`[Embedding] Progress: ${i + 1}/${totalChunks} chunks indexed`);
      }
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
