/**
 * @fileoverview Semantic search over the data folder and history via SQLite vector tables.
 * @module lib/knowledge/search
 */

import type { AppContext } from "../context";
import type { EmbeddingAdapter } from "./embedding";
import { getSettings } from "../settings";
import { createVectorStore } from "./vector-store";

/**
 * @brief Returns ISO cutoff for archive exclusion when configured.
 * @param ctx App context
 */
function getArchiveCutoff(ctx: AppContext): string | undefined {
  const s = getSettings(ctx);
  if (s.archiveDurationValue <= 0) return undefined;
  const now = Date.now();
  const unitMs: Record<string, number> = {
    seconds: 1000,
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,
    years: 365 * 24 * 60 * 60 * 1000,
  };
  const ms =
    (unitMs[s.archiveDurationUnit] ?? unitMs.days) * s.archiveDurationValue;
  return new Date(now - ms).toISOString();
}

export interface KnowledgeSearchResult {
  path: string;
  content: string;
  score: number;
  /** ISO timestamp when the file was last updated (embedding upsert). */
  last_modified: string;
}

export interface HistorySearchResult {
  sessionId: string;
  entryId: string;
  content: string;
  isCompressed: boolean;
  score: number;
  /** ISO timestamp when the entry was indexed (for recency boost). */
  createdAt: string;
}

export interface SearchKnowledgeOptions {
  /** Scope: self (current agent), user (data/user), global (all), or another agent id. Default "self". */
  scope?: "self" | "user" | "global" | string;
  /** Include files older than archive duration. Default false. */
  includeArchived?: boolean;
  /** Current agent id (used when scope is "self"). */
  agentId?: string;
  /** Precomputed query embedding; when provided, embedder.embed(query) is skipped. */
  queryEmbedding?: number[];
}

/**
 * @brief Semantic search over indexed knowledge files.
 * @param ctx App context
 * @param embedder Embedding adapter
 * @param query Search text
 * @param limit Max results
 * @param options Scope and archive options
 */
export async function searchKnowledge(
  ctx: AppContext,
  embedder: EmbeddingAdapter,
  query: string,
  limit = 5,
  options: SearchKnowledgeOptions = {},
): Promise<KnowledgeSearchResult[]> {
  try {
    const store = createVectorStore(ctx.db);
    const queryEmbedding =
      options.queryEmbedding ?? (await embedder.embed(query));
    const hits = store.searchKnowledge(queryEmbedding, limit, {
      pathPrefix: options.agentId ? `agents/${options.agentId}/` : undefined,
      excludeArchivedBefore: options.includeArchived
        ? undefined
        : getArchiveCutoff(ctx),
    });
    return hits.map((h) => ({
      path: h.path,
      content: h.content,
      score: h.score,
      last_modified: h.last_modified,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      "[Knowledge search] searchKnowledge (vector store): failed, returning empty:",
      msg,
    );
    return [];
  }
}

/**
 * @brief Semantic search over history vectors.
 * @param queryEmbedding Optional precomputed embedding
 */
export async function searchHistory(
  ctx: AppContext,
  embedder: EmbeddingAdapter,
  query: string,
  limit = 5,
  queryEmbedding?: number[],
): Promise<HistorySearchResult[]> {
  try {
    const store = createVectorStore(ctx.db);
    const embedding = queryEmbedding ?? (await embedder.embed(query));
    const hits = store.searchHistory(embedding, limit);
    return hits.map((h) => ({
      sessionId: h.sessionId,
      entryId: h.entryId,
      content: h.content,
      isCompressed: h.isCompressed,
      score: h.score,
      createdAt: h.createdAt,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      "[Knowledge search] searchHistory (vector store): failed, returning empty:",
      msg,
    );
    return [];
  }
}
