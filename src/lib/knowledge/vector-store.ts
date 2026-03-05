/**
 * @fileoverview Vector store (deprecated for semantic memory). Cosine similarity helper still used by skills.
 * @module lib/knowledge/vector-store
 *
 * Semantic search now uses MuninnDB. knowledge_vectors and history_vectors are no longer read or written
 * by the app; this module remains for cosineSimilarity() used by find-skill and skills/match, and for
 * one-time migration reads (migrate-vectors-to-muninn uses raw db, not this store).
 */

import type { DbAdapter } from "../context";

/** Cosine similarity between two vectors. Exported for skills matching. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function parseEmbedding(json: string): number[] {
  const arr = JSON.parse(json) as unknown;
  if (!Array.isArray(arr)) throw new Error("Invalid embedding_json");
  return arr as number[];
}

export interface KnowledgeHit {
  id: string;
  path: string;
  content: string;
  score: number;
  /** ISO timestamp when the file was last updated (embedding upsert). */
  last_modified: string;
}

export interface HistoryHit {
  id: string;
  sessionId: string;
  entryId: string;
  content: string;
  isCompressed: boolean;
  score: number;
  /** ISO timestamp when the entry was indexed (for recency boost). */
  createdAt: string;
}

/**
 * Vector store backed by SQLite tables knowledge_vectors and history_vectors.
 * Embeddings are stored as JSON arrays; similarity is computed in JS.
 */
export function createVectorStore(db: DbAdapter) {
  return {
    /** Upsert a knowledge document by path. Replaces if path exists. */
    upsertKnowledge(
      id: string,
      path: string,
      content: string,
      contentHash: string,
      embedding: number[],
      updatedAt: string,
    ): void {
      const stmt = db.prepare(
        `INSERT INTO knowledge_vectors (id, path, content, content_hash, embedding_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           id = excluded.id,
           content = excluded.content,
           content_hash = excluded.content_hash,
           embedding_json = excluded.embedding_json,
           updated_at = excluded.updated_at`,
      );
      stmt.run(
        id,
        path,
        content,
        contentHash,
        JSON.stringify(embedding),
        updatedAt,
      );
    },

    /** Delete knowledge document by path. */
    deleteKnowledgeByPath(path: string): void {
      db.prepare("DELETE FROM knowledge_vectors WHERE path = ?").run(path);
    },

    /**
     * Clear all knowledge and history embeddings.
     * @brief Deletes all rows from knowledge_vectors and history_vectors. Used before full rebuild.
     */
    clearAll(): void {
      db.prepare("DELETE FROM knowledge_vectors").run();
      db.prepare("DELETE FROM history_vectors").run();
    },

    /** Get all knowledge paths (for change detection). */
    getAllKnowledgePaths(): string[] {
      const rows = db.prepare("SELECT path FROM knowledge_vectors").all() as {
        path: string;
      }[];
      return rows.map((r) => r.path);
    },

    /** Get content hash for path if present. */
    getKnowledgeHash(path: string): string | null {
      const row = db
        .prepare("SELECT content_hash FROM knowledge_vectors WHERE path = ?")
        .get(path) as { content_hash: string } | undefined;
      return row?.content_hash ?? null;
    },

    /**
     * Semantic search over knowledge. Returns top-k by cosine similarity.
     * @param queryEmbedding - Query vector
     * @param limit - Max results
     * @param options - Optional pathPrefix (e.g. "agents/maia/") and excludeArchivedBefore (ISO timestamp: exclude rows with updated_at before this)
     */
    searchKnowledge(
      queryEmbedding: number[],
      limit: number,
      options?: { pathPrefix?: string; excludeArchivedBefore?: string },
    ): KnowledgeHit[] {
      let rows: {
        id: string;
        path: string;
        content: string;
        embedding_json: string;
        updated_at: string;
      }[];
      if (
        options?.pathPrefix != null ||
        options?.excludeArchivedBefore != null
      ) {
        const conditions: string[] = [];
        const params: (string | number)[] = [];
        if (options.pathPrefix != null) {
          conditions.push("path LIKE ?");
          params.push(`${options.pathPrefix}%`);
        }
        if (options.excludeArchivedBefore != null) {
          conditions.push("updated_at >= ?");
          params.push(options.excludeArchivedBefore);
        }
        const where = conditions.length
          ? `WHERE ${conditions.join(" AND ")}`
          : "";
        rows = db
          .prepare(
            `SELECT id, path, content, embedding_json, updated_at FROM knowledge_vectors ${where}`,
          )
          .all(...params) as {
          id: string;
          path: string;
          content: string;
          embedding_json: string;
          updated_at: string;
        }[];
      } else {
        rows = db
          .prepare(
            "SELECT id, path, content, embedding_json, updated_at FROM knowledge_vectors",
          )
          .all() as {
          id: string;
          path: string;
          content: string;
          embedding_json: string;
          updated_at: string;
        }[];
      }
      const withScore = rows.map((r) => ({
        ...r,
        score: cosineSimilarity(
          queryEmbedding,
          parseEmbedding(r.embedding_json),
        ),
      }));
      withScore.sort((a, b) => b.score - a.score);
      return withScore
        .slice(0, limit)
        .map(({ id, path, content, score, updated_at }) => ({
          id,
          path,
          content,
          score,
          last_modified: updated_at,
        }));
    },

    /** Insert a history entry into the vector store. */
    insertHistory(
      id: string,
      sessionId: string,
      entryId: string,
      content: string,
      embedding: number[],
      isCompressed: boolean,
      createdAt: string,
    ): void {
      db.prepare(
        `INSERT INTO history_vectors (id, session_id, entry_id, content, embedding_json, is_compressed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        sessionId,
        entryId,
        content,
        JSON.stringify(embedding),
        isCompressed ? 1 : 0,
        createdAt,
      );
    },

    /**
     * Semantic search over history. Returns top-k by cosine similarity.
     * When an entry has multiple vector rows (chunks), returns at most one hit per entry_id
     * (the chunk with the highest score for that entry).
     */
    searchHistory(queryEmbedding: number[], limit: number): HistoryHit[] {
      const rows = db
        .prepare(
          "SELECT id, session_id, entry_id, content, embedding_json, is_compressed, created_at FROM history_vectors",
        )
        .all() as {
        id: string;
        session_id: string;
        entry_id: string;
        content: string;
        embedding_json: string;
        is_compressed: number;
        created_at: string;
      }[];
      const withScore = rows.map((r) => ({
        ...r,
        score: cosineSimilarity(
          queryEmbedding,
          parseEmbedding(r.embedding_json),
        ),
      }));
      // Collapse by entry_id: keep the hit with max score per entry
      const bestByEntry = new Map<
        string,
        {
          id: string;
          session_id: string;
          entry_id: string;
          content: string;
          is_compressed: number;
          score: number;
          created_at: string;
        }
      >();
      for (const r of withScore) {
        const existing = bestByEntry.get(r.entry_id);
        if (!existing || r.score > existing.score) {
          bestByEntry.set(r.entry_id, r);
        }
      }
      const collapsed = Array.from(bestByEntry.values());
      collapsed.sort((a, b) => b.score - a.score);
      return collapsed.slice(0, limit).map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        entryId: r.entry_id,
        content: r.content,
        isCompressed: r.is_compressed === 1,
        score: r.score,
        createdAt: r.created_at,
      }));
    },
  };
}

export type VectorStore = ReturnType<typeof createVectorStore>;
