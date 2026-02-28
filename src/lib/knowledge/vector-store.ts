/**
 * @fileoverview Vector store for knowledge base and history semantic search.
 * @module lib/knowledge/vector-store
 *
 * Stores embeddings in SQLite (knowledge_vectors, history_vectors) and
 * performs cosine similarity search in application code.
 */

import type { DbAdapter } from "../context";

/** Cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
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
}

export interface HistoryHit {
  id: string;
  sessionId: string;
  entryId: string;
  content: string;
  isCompressed: boolean;
  score: number;
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
      updatedAt: string
    ): void {
      const stmt = db.prepare(
        `INSERT INTO knowledge_vectors (id, path, content, content_hash, embedding_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           id = excluded.id,
           content = excluded.content,
           content_hash = excluded.content_hash,
           embedding_json = excluded.embedding_json,
           updated_at = excluded.updated_at`
      );
      stmt.run(id, path, content, contentHash, JSON.stringify(embedding), updatedAt);
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
      const rows = db.prepare("SELECT path FROM knowledge_vectors").all() as { path: string }[];
      return rows.map((r) => r.path);
    },

    /** Get content hash for path if present. */
    getKnowledgeHash(path: string): string | null {
      const row = db.prepare("SELECT content_hash FROM knowledge_vectors WHERE path = ?").get(path) as
        | { content_hash: string }
        | undefined;
      return row?.content_hash ?? null;
    },

    /** Semantic search over knowledge. Returns top-k by cosine similarity. */
    searchKnowledge(queryEmbedding: number[], limit: number): KnowledgeHit[] {
      const rows = db
        .prepare("SELECT id, path, content, embedding_json FROM knowledge_vectors")
        .all() as { id: string; path: string; content: string; embedding_json: string }[];
      const withScore = rows.map((r) => ({
        ...r,
        score: cosineSimilarity(queryEmbedding, parseEmbedding(r.embedding_json)),
      }));
      withScore.sort((a, b) => b.score - a.score);
      return withScore.slice(0, limit).map(({ id, path, content, score }) => ({
        id,
        path,
        content,
        score,
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
      createdAt: string
    ): void {
      db.prepare(
        `INSERT INTO history_vectors (id, session_id, entry_id, content, embedding_json, is_compressed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, sessionId, entryId, content, JSON.stringify(embedding), isCompressed ? 1 : 0, createdAt);
    },

    /**
     * Semantic search over history. Returns top-k by cosine similarity.
     * When an entry has multiple vector rows (chunks), returns at most one hit per entry_id
     * (the chunk with the highest score for that entry).
     */
    searchHistory(queryEmbedding: number[], limit: number): HistoryHit[] {
      const rows = db
        .prepare(
          "SELECT id, session_id, entry_id, content, embedding_json, is_compressed FROM history_vectors"
        )
        .all() as {
        id: string;
        session_id: string;
        entry_id: string;
        content: string;
        embedding_json: string;
        is_compressed: number;
      }[];
      const withScore = rows.map((r) => ({
        ...r,
        score: cosineSimilarity(queryEmbedding, parseEmbedding(r.embedding_json)),
      }));
      // Collapse by entry_id: keep the hit with max score per entry
      const bestByEntry = new Map<
        string,
        { id: string; session_id: string; entry_id: string; content: string; is_compressed: number; score: number }
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
      }));
    },
  };
}

export type VectorStore = ReturnType<typeof createVectorStore>;
