/**
 * @fileoverview Cross-session episodic memory (Stinger analogue): episodes and typed edges.
 * @module lib/memory/graph
 */

import { v4 as uuidv4 } from "uuid";
import { cosineSimilarity } from "../knowledge/vector-store";
import type { AppContext } from "../context";

/**
 * @brief Store a short episode linked to session history entry ids.
 * @param ctx App context
 * @param agentId Agent id
 * @param sessionId Session id
 * @param entryIds History entry ids included in the episode
 * @param summary Short summary text
 * @param embedding Vector for the summary
 * @returns Episode id
 */
export function insertMemoryEpisode(
  ctx: AppContext,
  agentId: string,
  sessionId: string,
  entryIds: string[],
  summary: string,
  embedding: number[],
): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO memory_episodes (
         id, agent_id, session_id, entry_ids_json, summary, embedding_json, created_at, accessed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      agentId,
      sessionId,
      JSON.stringify(entryIds),
      summary.trim(),
      JSON.stringify(embedding),
      now,
      now,
    );
  return id;
}

/**
 * @brief Semantic search over episodes for an agent.
 * @param ctx App context
 * @param agentId Agent id
 * @param queryEmbedding Query vector
 * @param limit Max results
 */
export function searchMemoryEpisodes(
  ctx: AppContext,
  agentId: string,
  queryEmbedding: number[],
  limit: number,
): Array<{
  id: string;
  sessionId: string;
  summary: string;
  score: number;
  entryIds: string[];
}> {
  const rows = ctx.db
    .prepare(
      "SELECT id, session_id, summary, embedding_json, entry_ids_json FROM memory_episodes WHERE agent_id = ?",
    )
    .all(agentId) as Array<{
    id: string;
    session_id: string;
    summary: string;
    embedding_json: string;
    entry_ids_json: string;
  }>;
  const out = rows
    .map((r) => {
      let emb: number[];
      try {
        emb = JSON.parse(r.embedding_json) as number[];
      } catch {
        return {
          id: r.id,
          sessionId: r.session_id,
          summary: r.summary,
          score: 0,
          entryIds: [] as string[],
        };
      }
      let entryIds: string[] = [];
      try {
        const parsed = JSON.parse(r.entry_ids_json) as unknown;
        if (Array.isArray(parsed))
          entryIds = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        entryIds = [];
      }
      return {
        id: r.id,
        sessionId: r.session_id,
        summary: r.summary,
        score: cosineSimilarity(queryEmbedding, emb),
        entryIds,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return out;
}

/** @brief Create entity node */
export function insertMemoryEntity(
  ctx: AppContext,
  agentId: string,
  name: string,
  kind: string,
  metadata: Record<string, string>,
): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO memory_entities (id, agent_id, name, kind, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, agentId, name.trim(), kind, JSON.stringify(metadata), now);
  return id;
}

/** @brief Link two ids (episodes or entities) with a relation label */
export function insertMemoryEdge(
  ctx: AppContext,
  agentId: string,
  fromId: string,
  toId: string,
  relation: string,
): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO memory_edges (id, agent_id, from_id, to_id, relation, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, agentId, fromId, toId, relation, now);
  return id;
}

/**
 * @brief Neighbor ids one hop from seed via edges (same agent).
 * @param ctx App context
 * @param agentId Agent id
 * @param seedId Start node id
 */
export function expandGraphNeighbors(
  ctx: AppContext,
  agentId: string,
  seedId: string,
): string[] {
  const rows = ctx.db
    .prepare(
      "SELECT to_id, from_id FROM memory_edges WHERE agent_id = ? AND (from_id = ? OR to_id = ?)",
    )
    .all(agentId, seedId, seedId) as Array<{ to_id: string; from_id: string }>;
  const neighbors = new Set<string>();
  for (const r of rows) {
    if (r.from_id !== seedId) neighbors.add(r.from_id);
    if (r.to_id !== seedId) neighbors.add(r.to_id);
  }
  return [...neighbors];
}
