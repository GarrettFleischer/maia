/**
 * @fileoverview Rebuild or build embeddings from knowledge files and history.
 * @module lib/knowledge/rebuild-embeddings
 *
 * Uses SQLite vector tables (knowledge_vectors, history_vectors) and the configured embedder.
 */

import { runKnowledgeIndex } from "./index";
import { refreshEmbeddings } from "./refresh-embeddings";
import { indexHistoryEntry } from "./history-index";
import { createVectorStore } from "./vector-store";
import type { AppContext } from "../context";

export interface RebuildEmbeddingsResult {
  knowledgeIndexed: number;
  knowledgeRemoved: number;
  historyIndexed: number;
}

/**
 * @brief Rebuild semantic memory: clear vectors, re-index knowledge and all history entries.
 * @param ctx App context
 */
export async function rebuildEmbeddings(
  ctx: AppContext,
): Promise<RebuildEmbeddingsResult> {
  const store = createVectorStore(ctx.db);
  store.clearAll();
  const { indexed: knowledgeIndexed, removed: knowledgeRemoved } =
    await runKnowledgeIndex(ctx, {});
  await refreshEmbeddings(ctx);
  const historyRows = ctx.db
    .prepare(
      "SELECT id FROM history_entries WHERE content != '' AND role != 'smart_context'",
    )
    .all() as { id: string }[];
  for (const row of historyRows) {
    await indexHistoryEntry(ctx, row.id);
  }
  return {
    knowledgeIndexed,
    knowledgeRemoved,
    historyIndexed: historyRows.length,
  };
}

export interface BuildEmbeddingsResult {
  knowledgeIndexed: number;
  knowledgeRemoved: number;
  historyIndexed: number;
}

/**
 * @brief Incremental index: new/changed knowledge and history without full clear.
 * @param ctx App context
 */
export async function buildEmbeddings(
  ctx: AppContext,
): Promise<BuildEmbeddingsResult> {
  const store = createVectorStore(ctx.db);
  const { indexed: knowledgeIndexed, removed: knowledgeRemoved } =
    await runKnowledgeIndex(ctx, {});
  await refreshEmbeddings(ctx);
  const historyRows = ctx.db
    .prepare(
      "SELECT id FROM history_entries WHERE content != '' AND role != 'smart_context'",
    )
    .all() as { id: string }[];
  for (const row of historyRows) {
    store.deleteHistoryByEntryId(row.id);
    await indexHistoryEntry(ctx, row.id);
  }
  return {
    knowledgeIndexed,
    knowledgeRemoved,
    historyIndexed: historyRows.length,
  };
}
