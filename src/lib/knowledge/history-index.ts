/**
 * @fileoverview Index a single history entry into the vector store for semantic search.
 * @module lib/knowledge/history-index
 *
 * Called fire-and-forget after appending entries (original and compressed).
 */

import { v4 as uuidv4 } from "uuid";
import { createEmbeddingAdapter } from "./embedding";
import { createVectorStore } from "./vector-store";
import { getSettings } from "../settings";
import type { AppContext } from "../context";

/** Max characters to send to the embedding model (avoids context-length 400 from Ollama). */
const MAX_EMBED_CONTENT_LENGTH = 6000;

/**
 * Load an entry from history_entries, embed its content, and insert into history_vectors.
 * Content is truncated to MAX_EMBED_CONTENT_LENGTH to avoid exceeding the model context.
 * Safe to call fire-and-forget; logs errors and does not throw.
 */
export async function indexHistoryEntry(ctx: AppContext, entryId: string): Promise<void> {
  const row = ctx.db
    .prepare(
      "SELECT id, session_id, role, content, tool_name, tool_args, timestamp, is_compressed FROM history_entries WHERE id = ?"
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

  // Skip indexing empty content (e.g. compressed skip entries); nothing to embed and Ollama may return invalid shape.
  if (row.content.trim() === "") return;

  const contentToEmbed =
    row.content.length > MAX_EMBED_CONTENT_LENGTH
      ? row.content.slice(0, MAX_EMBED_CONTENT_LENGTH)
      : row.content;

  const settings = getSettings(ctx);
  const embedder = createEmbeddingAdapter(settings, ctx.http);
  const embedding = await embedder.embed(contentToEmbed);
  const store = createVectorStore(ctx.db);
  const id = uuidv4();
  const now = new Date().toISOString();
  store.insertHistory(
    id,
    row.session_id,
    row.id,
    row.content,
    embedding,
    row.is_compressed === 1,
    now
  );
}
