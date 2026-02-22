/**
 * @fileoverview Semantic search over the knowledge base and (optionally) history.
 * @module lib/knowledge/search
 */

import type { AppContext } from "../context";
import type { EmbeddingAdapter } from "./embedding";
import { createVectorStore } from "./vector-store";

export interface KnowledgeSearchResult {
  path: string;
  content: string;
  score: number;
}

export interface HistorySearchResult {
  sessionId: string;
  entryId: string;
  content: string;
  isCompressed: boolean;
  score: number;
}

/**
 * Semantic search over the knowledge base. Returns top-k documents (full content).
 * @param ctx - App context (db)
 * @param embedder - Embedding adapter
 * @param query - Search query text
 * @param limit - Max results (default 5)
 */
export async function searchKnowledge(
  ctx: AppContext,
  embedder: EmbeddingAdapter,
  query: string,
  limit = 5
): Promise<KnowledgeSearchResult[]> {
  const store = createVectorStore(ctx.db);
  const queryEmbedding = await embedder.embed(query);
  const hits = store.searchKnowledge(queryEmbedding, limit);
  return hits.map((h) => ({ path: h.path, content: h.content, score: h.score }));
}

/**
 * Semantic search over history entries. Returns top-k entries.
 */
export async function searchHistory(
  ctx: AppContext,
  embedder: EmbeddingAdapter,
  query: string,
  limit = 5
): Promise<HistorySearchResult[]> {
  const store = createVectorStore(ctx.db);
  const queryEmbedding = await embedder.embed(query);
  const hits = store.searchHistory(queryEmbedding, limit);
  return hits.map((h) => ({
    sessionId: h.sessionId,
    entryId: h.entryId,
    content: h.content,
    isCompressed: h.isCompressed,
    score: h.score,
  }));
}
