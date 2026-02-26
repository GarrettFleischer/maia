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

/**
 * Load an entry from history_entries, embed its content, and insert into history_vectors.
 * Content is truncated to settings.embedMaxContentLength to avoid exceeding the model context.
 * Safe to call fire-and-forget; logs errors and does not throw.
 */
export async function indexHistoryEntry(ctx: AppContext, entryId: string): Promise<void> {
  // #region agent log
  fetch("http://127.0.0.1:7245/ingest/13540c59-9d40-405a-a4df-e70acbf0e8f0", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "73f7a4" },
    body: JSON.stringify({
      sessionId: "73f7a4",
      location: "history-index.ts:entry",
      message: "indexHistoryEntry called",
      data: { entryId },
      timestamp: Date.now(),
      hypothesisId: "H4",
    }),
  }).catch(() => {});
  // #endregion
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

  const settings = getSettings(ctx);
  const maxLen = settings.embedMaxContentLength;
  const contentToEmbed =
    row.content.length > maxLen ? row.content.slice(0, maxLen) : row.content;

  try {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    const causeCode =
      err instanceof Error && err.cause && typeof (err.cause as { code?: string }).code === "string"
        ? (err.cause as { code: string }).code
        : undefined;
    const isRefused =
      causeCode === "ECONNREFUSED" ||
      msg.includes("ECONNREFUSED") ||
      cause.includes("ECONNREFUSED");
    const hint = isRefused ? " (embedding service not running?)" : "";
    const settings = getSettings(ctx);
    const embedUrl = `${settings.ollamaBaseUrl.replace(/\/$/, "")}/api/embed`;
    // #region agent log
    fetch("http://127.0.0.1:7245/ingest/13540c59-9d40-405a-a4df-e70acbf0e8f0", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "73f7a4" },
      body: JSON.stringify({
        sessionId: "73f7a4",
        location: "history-index.ts:catch",
        message: "History indexing skip",
        data: { entryId, msg, cause, causeCode, hint, embedUrl },
        timestamp: Date.now(),
        hypothesisId: "H1-H5",
      }),
    }).catch(() => {});
    // #endregion
    console.error("History indexing skipped:", msg + hint, `(${embedUrl})`);
  }
}
