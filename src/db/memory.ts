/**
 * @fileoverview Per-agent long-term memory (chunks). Scoped by agent_id; no cross-agent access.
 * @module db/memory
 */

import { randomUUID } from "node:crypto";
import type { DbClient } from "./client";

export type MemoryChunkRecord = {
  id: string;
  agent_id: string;
  content: string;
  created_at: number;
};

export function createMemoryRepository(db: DbClient) {
  return {
    async insert(agentId: string, content: string): Promise<string> {
      const id = randomUUID();
      const now = Date.now();
      db.run(
        "INSERT INTO memory_chunks (id, agent_id, content, created_at) VALUES (?, ?, ?, ?)",
        [id, agentId, content, now]
      );
      return id;
    },
    async search(agentId: string, query: string): Promise<MemoryChunkRecord[]> {
      const like = `%${query.replace(/%/g, "\\%")}%`;
      return db.all<MemoryChunkRecord>(
        "SELECT * FROM memory_chunks WHERE agent_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC",
        [agentId, like]
      );
    },
    async delete(agentId: string, id: string): Promise<void> {
      db.run("DELETE FROM memory_chunks WHERE id = ? AND agent_id = ?", [
        id,
        agentId,
      ]);
    },
  };
}
