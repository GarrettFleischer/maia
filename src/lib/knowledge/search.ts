/**
 * @fileoverview Semantic search over the data folder and history via MuninnDB.
 * When Muninn URL is set, uses Muninn activate; otherwise returns empty results.
 * @module lib/knowledge/search
 */

import type { AppContext } from "../context";
import type { EmbeddingAdapter } from "./embedding";
import { getMuninnConfig } from "../muninn/config";
import { createMuninnClient } from "../muninn/client";

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
  options: SearchKnowledgeOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const muninnConfig = getMuninnConfig(ctx);
  if (!muninnConfig.enabled) {
    return [];
  }
  try {
    const client = createMuninnClient(ctx.http, muninnConfig.baseUrl);
    const res = await client.activate("default", [query], limit);
    const results: KnowledgeSearchResult[] = [];
    for (const a of res.activations) {
      const tags = a.tags ?? [];
      if (tags[0] === "knowledge" && typeof tags[1] === "string") {
        results.push({
          path: tags[1],
          content: a.content,
          score: a.score,
          last_modified: "",
        });
      }
    }
    return results.slice(0, limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      "[Knowledge search] searchKnowledge (Muninn): failed, returning empty:",
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
  queryEmbedding?: number[],
): Promise<HistorySearchResult[]> {
  const muninnConfig = getMuninnConfig(ctx);
  if (!muninnConfig.enabled) {
    return [];
  }
  try {
    const client = createMuninnClient(ctx.http, muninnConfig.baseUrl);
    const res = await client.activate("default", [query], limit);
    const results: HistorySearchResult[] = [];
    for (const a of res.activations) {
      const tags = a.tags ?? [];
      if (
        tags[0] === "history" &&
        tags.length >= 3 &&
        typeof tags[1] === "string" &&
        typeof tags[2] === "string"
      ) {
        results.push({
          sessionId: tags[1],
          entryId: tags[2],
          content: a.content,
          isCompressed: tags.includes("compressed"),
          score: a.score,
          createdAt: "",
        });
      }
    }
    return results.slice(0, limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      "[Knowledge search] searchHistory (Muninn): failed, returning empty:",
      msg,
    );
    return [];
  }
}
