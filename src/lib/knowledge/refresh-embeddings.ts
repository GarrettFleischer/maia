/**
 * @fileoverview Embedding refresh hook (no-op); history is indexed on append via indexHistoryEntry.
 * @module lib/knowledge/refresh-embeddings
 */

import type { AppContext } from "../context";

/**
 * @brief Reserved for API compatibility (e.g. heartbeat); does not mutate vectors.
 * @param _ctx Application context (unused)
 */
export async function refreshEmbeddings(_ctx: AppContext): Promise<void> {
  // Semantic memory is indexed on append via indexHistoryEntry.
}
