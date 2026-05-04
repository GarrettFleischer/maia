/**
 * @fileoverview Gigabrain-style memory registry in SQLite: embedded rows per agent with dedupe and quality.
 * @module lib/memory/registry
 */

import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { cosineSimilarity } from "../knowledge/vector-store";
import type { AppContext } from "../context";

const DEDUPE_PREFIX_LENGTH = 240;

/**
 * @brief Stable hash for dedupe (normalized content prefix).
 * @param content Raw memory text
 * @returns Hex digest
 */
export function registryDedupeHash(content: string): string {
  const norm = content.trim().toLowerCase().slice(0, DEDUPE_PREFIX_LENGTH);
  return crypto.createHash("sha256").update(norm).digest("hex");
}

/**
 * @brief Insert or skip duplicate registry row for an agent.
 * @param ctx App context
 * @param agentId Agent id
 * @param content Memory text
 * @param embedding Vector from embedder
 * @param sourceKind explicit | conversation | promotion
 * @param qualityScore 0–1
 * @returns Row id or existing id when duplicate hash
 */
export function insertRegistryMemory(
  ctx: AppContext,
  agentId: string,
  content: string,
  embedding: number[],
  sourceKind: string,
  qualityScore: number,
): string {
  const dedupe = registryDedupeHash(content);
  const existing = ctx.db
    .prepare(
      "SELECT id FROM memory_registry WHERE agent_id = ? AND dedupe_hash = ? LIMIT 1",
    )
    .get(agentId, dedupe) as { id: string } | undefined;
  if (existing) {
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        "UPDATE memory_registry SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
      )
      .run(now, existing.id);
    return existing.id;
  }
  const id = uuidv4();
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO memory_registry (
         id, agent_id, content, embedding_json, quality_score,
         source_kind, dedupe_hash, created_at, accessed_at, access_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      agentId,
      content.trim(),
      JSON.stringify(embedding),
      qualityScore,
      sourceKind,
      dedupe,
      now,
      now,
    );
  return id;
}

/**
 * @brief Rank registry rows by cosine similarity to query embedding.
 * @param ctx App context
 * @param agentId Agent id
 * @param queryEmbedding Query vector
 * @param limit Max rows
 * @param minQuality Minimum quality_score
 */
export function searchRegistryMemories(
  ctx: AppContext,
  agentId: string,
  queryEmbedding: number[],
  limit: number,
  minQuality = 0.15,
): Array<{ id: string; content: string; score: number }> {
  const rows = ctx.db
    .prepare(
      "SELECT id, content, embedding_json, quality_score FROM memory_registry WHERE agent_id = ?",
    )
    .all(agentId) as Array<{
    id: string;
    content: string;
    embedding_json: string;
    quality_score: number;
  }>;
  const ranked = rows
    .map((r) => {
      let emb: number[];
      try {
        emb = JSON.parse(r.embedding_json) as number[];
      } catch {
        return { id: r.id, content: r.content, score: 0 };
      }
      const sim = cosineSimilarity(queryEmbedding, emb) * (r.quality_score ?? 1);
      return { id: r.id, content: r.content, score: sim };
    })
    .filter((r) => r.score >= minQuality)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ranked;
}

/**
 * @brief Mark registry hits as accessed (recency for maintenance).
 * @param ctx App context
 * @param ids Registry row ids
 */
export function touchRegistryMemories(ctx: AppContext, ids: string[]): void {
  const now = new Date().toISOString();
  const stmt = ctx.db.prepare(
    "UPDATE memory_registry SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
  );
  for (const id of ids) stmt.run(now, id);
}

/**
 * @brief Delete lowest-quality, old registry rows past cap (maintenance).
 * @param ctx App context
 * @param agentId Agent id
 * @param maxRows Keep at most this many rows per agent
 */
export function pruneRegistryIfOverCap(
  ctx: AppContext,
  agentId: string,
  maxRows: number,
): number {
  const count = (
    ctx.db
      .prepare("SELECT COUNT(1) as c FROM memory_registry WHERE agent_id = ?")
      .get(agentId) as { c: number }
  ).c;
  if (count <= maxRows) return 0;
  const toDelete = count - maxRows;
  const rows = ctx.db
    .prepare(
      `SELECT id FROM memory_registry WHERE agent_id = ?
       ORDER BY quality_score ASC, accessed_at ASC LIMIT ?`,
    )
    .all(agentId, toDelete) as { id: string }[];
  const del = ctx.db.prepare("DELETE FROM memory_registry WHERE id = ?");
  for (const r of rows) del.run(r.id);
  return rows.length;
}
