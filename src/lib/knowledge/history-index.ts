/**
 * @fileoverview Index a single history entry into the vector store for semantic search.
 * @module lib/knowledge/history-index
 *
 * Called fire-and-forget after appending entries (original and compressed).
 * Long content is chunked using the model's context length; multiple vectors may be stored per entry.
 */

import { v4 as uuidv4 } from "uuid";
import {
  createEmbeddingAdapter,
  getEffectiveEmbedMaxLength,
  chunkContentForEmbedding,
} from "./embedding";
import { createVectorStore } from "./vector-store";
import { getSettings } from "../settings";
import type { AppContext } from "../context";

/**
 * Load an entry from history_entries, embed its content, and insert into history_vectors.
 * Uses effective max length (Ollama context when available) and chunks long content into multiple vectors per entry.
 * Safe to call fire-and-forget; logs errors and does not throw.
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

  // Skip UI-only entries (smart_context); not part of conversation search.
  const role = (row as { role?: string }).role;
  if (role === "smart_context") return;

  // Skip indexing empty content (e.g. compressed skip entries); nothing to embed and Ollama may return invalid shape.
  if (row.content.trim() === "") return;

  const settings = getSettings(ctx);

  try {
    const maxLen = await getEffectiveEmbedMaxLength(settings, ctx.http);
    const chunks = chunkContentForEmbedding(row.content, maxLen);
    const embedder = createEmbeddingAdapter(settings, ctx.http);
    const store = createVectorStore(ctx.db);
    const now = new Date().toISOString();
    if (chunks.length > 1) {
      console.info(
        `[Embedding] Indexing entry ${row.id}: ${chunks.length} chunks`,
      );
    }
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunks.length > 1) {
        console.info(
          `[Embedding] Entry ${row.id}: chunk ${i + 1}/${chunks.length}`,
        );
      }
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
    if (chunks.length > 1) {
      console.info(
        `[Embedding] Indexed entry ${row.id}: ${chunks.length} chunks`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : "";
    const causeCode =
      err instanceof Error &&
      err.cause &&
      typeof (err.cause as { code?: string }).code === "string"
        ? (err.cause as { code: string }).code
        : undefined;
    const isRefused =
      causeCode === "ECONNREFUSED" ||
      msg.includes("ECONNREFUSED") ||
      cause.includes("ECONNREFUSED");
    const hint = isRefused ? " (embedding service not running?)" : "";
    console.error(
      "History indexing skipped:",
      msg + hint,
      `(embedding model: ${settings.embeddingModel})`,
    );
  }
}
