/**
 * @fileoverview Hybrid search combining vector and text similarity (future).
 * @module memory/search
 * @brief For now executes simple SELECT with optional category filter and limit.
 */

import type {
  Database,
  Logger,
  MemoryCategory,
  MemorySearchResult,
} from "../core/types.js";

/** @brief Dependencies for createHybridSearch */
export interface HybridSearchDeps {
  db: Database;
  logger: Logger;
  vectorWeight: number;
  textWeight: number;
}

/** @brief Hybrid search interface */
export interface HybridSearch {
  search(
    query: string,
    options: { embedding: number[]; limit: number; category?: string }
  ): Promise<MemorySearchResult[]>;
}

/**
 * @brief Creates a hybrid search instance.
 * @param deps - Dependencies: db, logger, vectorWeight, textWeight
 * @returns HybridSearch interface
 */
export function createHybridSearch(deps: HybridSearchDeps): HybridSearch {
  const { db, logger } = deps;

  return {
    async search(
      query: string,
      options: { embedding: number[]; limit: number; category?: string }
    ): Promise<MemorySearchResult[]> {
      const { limit, category } = options;
      const pattern = `%${query.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;

      let sql = `SELECT id, text, category, importance, embedding, source_date, created_at, updated_at
                 FROM memories WHERE text LIKE ? ESCAPE '\\'`;
      const params: unknown[] = [pattern];

      if (category) {
        sql += ` AND category = ?`;
        params.push(category);
      }

      sql += ` ORDER BY importance DESC, updated_at DESC LIMIT ?`;
      params.push(limit);

      const rows = await db.query<{
        id: string;
        text: string;
        category: string;
        importance: number;
        embedding: string | null;
        source_date: string | null;
        created_at: string;
        updated_at: string;
      }>(sql, params);

      const results: MemorySearchResult[] = rows.map((row) => ({
        entry: {
          id: row.id,
          text: row.text,
          category: row.category as MemoryCategory,
          importance: row.importance,
          embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : undefined,
          sourceDate: row.source_date ?? undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        score: row.importance,
      }));

      logger.debug("Hybrid search", { query, limit, resultsCount: results.length });
      return results;
    },
  };
}
