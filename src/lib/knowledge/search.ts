/**
 * @fileoverview Semantic search over the data folder (and optionally history).
 * @module lib/knowledge/search
 */

import type { AppContext } from "../context";
import type { EmbeddingAdapter } from "./embedding";
import { createVectorStore } from "./vector-store";
import { getSettings } from "../settings";

export interface KnowledgeSearchResult {
  path: string;
  content: string;
  score: number;
  /** ISO timestamp when the file was last updated (embedding upsert). */
  last_modified: string;
}

/** Compute archive cutoff: ISO timestamp before which files are considered archived. */
function getArchiveCutoff(
  value: number,
  unit: "seconds" | "minutes" | "hours" | "days" | "months" | "years"
): string {
  if (value <= 0) return "";
  let seconds = value;
  switch (unit) {
    case "minutes":
      seconds *= 60;
      break;
    case "hours":
      seconds *= 3600;
      break;
    case "days":
      seconds *= 86400;
      break;
    case "months":
      seconds *= 86400 * 30;
      break;
    case "years":
      seconds *= 86400 * 365;
      break;
    default:
      break;
  }
  const cutoff = new Date(Date.now() - seconds * 1000);
  return cutoff.toISOString();
}

/** Map scope to path prefix (paths in store are relative to data/). */
function scopeToPathPrefix(
  scope: "self" | "user" | "global" | string,
  agentId: string
): string | undefined {
  if (scope === "global") return undefined;
  if (scope === "user") return "user/";
  if (scope === "self") return `agents/${agentId}/`;
  if (typeof scope === "string" && scope.length > 0) return `agents/${scope}/`;
  return undefined;
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
 * Semantic search over indexed data files. Returns top-k documents with last_modified.
 * @param ctx - App context (db)
 * @param embedder - Embedding adapter
 * @param query - Search query text
 * @param limit - Max results (default 5)
 * @param options - scope, includeArchived, agentId
 */
export async function searchKnowledge(
  ctx: AppContext,
  embedder: EmbeddingAdapter,
  query: string,
  limit = 5,
  options: SearchKnowledgeOptions = {}
): Promise<KnowledgeSearchResult[]> {
  const store = createVectorStore(ctx.db);
  const { scope = "self", includeArchived = false, agentId = "" } = options;
  const pathPrefix = scopeToPathPrefix(scope, agentId);
  const settings = getSettings(ctx);
  const excludeArchivedBefore =
    includeArchived || settings.archiveDurationValue <= 0
      ? undefined
      : getArchiveCutoff(settings.archiveDurationValue, settings.archiveDurationUnit);

  try {
    const queryEmbedding =
      options.queryEmbedding ?? (await embedder.embed(query));
    const hits = store.searchKnowledge(queryEmbedding, limit, {
      pathPrefix,
      excludeArchivedBefore,
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
      "[Knowledge search] searchKnowledge: embedding or vector search failed, returning empty results:",
      msg,
    );
    return [];
  }
}

/**
 * Semantic search over history entries. Returns top-k entries.
 * @param queryEmbedding - Optional precomputed embedding; when provided, embedder.embed(query) is skipped.
 */
export async function searchHistory(
  ctx: AppContext,
  embedder: EmbeddingAdapter,
  query: string,
  limit = 5,
  queryEmbedding?: number[]
): Promise<HistorySearchResult[]> {
  const store = createVectorStore(ctx.db);
  try {
    const embedding =
      queryEmbedding !== undefined ? queryEmbedding : await embedder.embed(query);
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
      "[Knowledge search] searchHistory: embedding or vector search failed, returning empty results:",
      msg,
    );
    return [];
  }
}
