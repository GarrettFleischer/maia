/**
 * @fileoverview Rebuild or build Muninn engrams from knowledge files and history.
 * @module lib/knowledge/rebuild-embeddings
 *
 * When Muninn is configured, (re)indexes knowledge files and history entries to Muninn.
 * When not configured, returns zeros.
 */

import { runKnowledgeIndex } from "./index";
import { refreshEmbeddings } from "./refresh-embeddings";
import { indexHistoryEntry } from "./history-index";
import { getMuninnConfig } from "../muninn/config";
import type { AppContext } from "../context";

export interface RebuildEmbeddingsResult {
  knowledgeIndexed: number;
  knowledgeRemoved: number;
  historyIndexed: number;
}

/**
 * Rebuilds Muninn from current knowledge files and history entries.
 * When Muninn is not configured, returns zeros.
 */
export async function rebuildEmbeddings(
  ctx: AppContext,
): Promise<RebuildEmbeddingsResult> {
  if (!getMuninnConfig(ctx).enabled) {
    return { knowledgeIndexed: 0, knowledgeRemoved: 0, historyIndexed: 0 };
  }
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
 * Indexes new/changed knowledge files and history entries to Muninn without clearing.
 * When Muninn is not configured, returns zeros.
 */
export async function buildEmbeddings(
  ctx: AppContext,
): Promise<BuildEmbeddingsResult> {
  if (!getMuninnConfig(ctx).enabled) {
    return { knowledgeIndexed: 0, knowledgeRemoved: 0, historyIndexed: 0 };
  }
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
