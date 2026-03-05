/**
 * @fileoverview Embedding refresh: no-op when using MuninnDB (history is indexed on append).
 * @module lib/knowledge/refresh-embeddings
 *
 * Semantic memory is written on append via indexHistoryEntry. This function is kept for API
 * compatibility (e.g. heartbeat tool) but does nothing.
 */

import type { AppContext } from "../context";

/**
 * No-op. History entries are written to Muninn on append; no separate refresh step.
 * @param _ctx - Application context (unused)
 */
export async function refreshEmbeddings(_ctx: AppContext): Promise<void> {
  // Semantic memory is indexed on append via indexHistoryEntry.
}
