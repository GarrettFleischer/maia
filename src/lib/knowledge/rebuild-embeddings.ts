/**
 * @fileoverview Clear all embeddings and rebuild from knowledge files and history.
 * @module lib/knowledge/rebuild-embeddings
 *
 * Deletes all rows from knowledge_vectors and history_vectors, then re-indexes
 * knowledge documents and history entries using the current embedding model.
 */

import { getSettings } from "../settings";
import { createEmbeddingAdapter } from "./embedding";
import { createVectorStore } from "./vector-store";
import { runKnowledgeIndex } from "./index";
import { refreshEmbeddings } from "./refresh-embeddings";
import type { AppContext } from "../context";

export interface RebuildEmbeddingsResult {
  knowledgeIndexed: number;
  knowledgeRemoved: number;
  historyIndexed: number;
}

/**
 * Clears all embeddings and rebuilds from knowledge files and history entries.
 * @param ctx - Application context
 * @returns Counts of indexed knowledge files and history entries
 */
export async function rebuildEmbeddings(ctx: AppContext): Promise<RebuildEmbeddingsResult> {
  const store = createVectorStore(ctx.db);
  store.clearAll();

  const settings = getSettings(ctx);
  const embedder = createEmbeddingAdapter(settings, ctx.http);

  const { indexed: knowledgeIndexed, removed: knowledgeRemoved } = await runKnowledgeIndex(ctx, {
    embedder,
  });

  await refreshEmbeddings(ctx);

  const historyCount = ctx.db
    .prepare("SELECT COUNT(*) as c FROM history_vectors")
    .get() as { c: number };

  return {
    knowledgeIndexed,
    knowledgeRemoved,
    historyIndexed: historyCount.c,
  };
}

export interface BuildEmbeddingsResult {
  knowledgeIndexed: number;
  knowledgeRemoved: number;
  historyIndexed: number;
}

/**
 * Indexes new/changed knowledge files and unindexed history entries without clearing.
 * Use to continue indexing after new content is added.
 * @param ctx - Application context
 * @returns Counts of indexed knowledge files and history vectors
 */
export async function buildEmbeddings(ctx: AppContext): Promise<BuildEmbeddingsResult> {
  const settings = getSettings(ctx);
  const embedder = createEmbeddingAdapter(settings, ctx.http);

  const { indexed: knowledgeIndexed, removed: knowledgeRemoved } = await runKnowledgeIndex(ctx, {
    embedder,
  });

  await refreshEmbeddings(ctx);

  const historyCount = ctx.db
    .prepare("SELECT COUNT(*) as c FROM history_vectors")
    .get() as { c: number };

  return {
    knowledgeIndexed,
    knowledgeRemoved,
    historyIndexed: historyCount.c,
  };
}
