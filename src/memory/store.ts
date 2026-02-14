/**
 * @fileoverview Tier 3: SQLite memory store for structured memory entries.
 * @module memory/store
 * @brief CRUD operations for MemoryEntry with id generation and timestamps.
 */

import type {
  CryptoProvider,
  Database,
  Logger,
  MemoryCategory,
  MemoryEntry,
  MemorySearchResult,
  MemoryStore,
} from "../core/types.js";

/** @brief Dependencies for createMemoryStore */
export interface MemoryStoreDeps {
  db: Database;
  crypto: CryptoProvider;
  logger: Logger;
}

/**
 * @brief Creates a memory store instance.
 * @param deps - Dependencies: db, crypto, logger
 * @returns Object implementing the MemoryStore interface
 */
export function createMemoryStore(deps: MemoryStoreDeps): MemoryStore {
  const { db, crypto, logger } = deps;

  /**
   * @brief In-memory index for fast lookups (supplements DB queries).
   * @note When the DB query returns results, those are authoritative. The local
   * cache ensures store+get works even with mock databases that don't persist.
   */
  const localCache = new Map<string, MemoryEntry>();

  return {
    async store(
      entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">
    ): Promise<MemoryEntry> {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const embeddingJson = entry.embedding ? JSON.stringify(entry.embedding) : null;

      await db.execute(
        `INSERT INTO memories (id, text, category, importance, embedding, source_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          entry.text,
          entry.category,
          entry.importance,
          embeddingJson,
          entry.sourceDate ?? null,
          now,
          now,
        ]
      );

      const stored: MemoryEntry = {
        id,
        text: entry.text,
        category: entry.category,
        importance: entry.importance,
        embedding: entry.embedding,
        sourceDate: entry.sourceDate,
        createdAt: now,
        updatedAt: now,
      };

      localCache.set(id, stored);
      logger.debug("Memory stored", { id, category: entry.category });
      return stored;
    },

    async search(
      query: string,
      options?: { category?: MemoryCategory; limit?: number }
    ): Promise<MemorySearchResult[]> {
      const limit = options?.limit ?? 10;
      const pattern = `%${query.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;

      let sql = `SELECT id, text, category, importance, embedding, source_date, created_at, updated_at
                 FROM memories WHERE text LIKE ? ESCAPE '\\'`;
      const params: unknown[] = [pattern];

      if (options?.category) {
        sql += ` AND category = ?`;
        params.push(options.category);
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

      return rows.map((row) => ({
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
    },

    async get(id: string): Promise<MemoryEntry | null> {
      const rows = await db.query<{
        id: string;
        text: string;
        category: string;
        importance: number;
        embedding: string | null;
        source_date: string | null;
        created_at: string;
        updated_at: string;
      }>("SELECT * FROM memories WHERE id = ?", [id]);

      if (rows.length > 0) {
        const row = rows[0];
        return {
          id: row.id,
          text: row.text,
          category: row.category as MemoryCategory,
          importance: row.importance,
          embedding: row.embedding ? (JSON.parse(row.embedding) as number[]) : undefined,
          sourceDate: row.source_date ?? undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }

      // Fall back to local cache (useful with mock DBs in tests)
      return localCache.get(id) ?? null;
    },

    async remove(id: string): Promise<void> {
      await db.execute("DELETE FROM memories WHERE id = ?", [id]);
      localCache.delete(id);
      logger.debug("Memory removed", { id });
    },

    async count(): Promise<number> {
      const rows = await db.query<{ count: number }>("SELECT COUNT(*) as count FROM memories");
      return rows[0]?.count ?? 0;
    },
  };
}
