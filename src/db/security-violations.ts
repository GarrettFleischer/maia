/**
 * @fileoverview Security violations repository: insert and count by agent (3-strikes).
 * @module db/security-violations
 */

import type { DbClient } from "./client";
import { randomUUID } from "node:crypto";

export type SecurityViolationRecord = {
  id: string;
  agent_id: string;
  reason: string;
  created_at: number;
};

export type SecurityViolationsRepository = {
  insert: (agentId: string, reason: string) => Promise<void>;
  countByAgent: (agentId: string) => Promise<number>;
  listByAgent: (agentId: string) => Promise<SecurityViolationRecord[]>;
};

/**
 * Creates the security violations repository.
 */
export function createSecurityViolationsRepository(
  db: DbClient
): SecurityViolationsRepository {
  return {
    async insert(agentId: string, reason: string): Promise<void> {
      const id = randomUUID();
      const now = Date.now();
      db.run(
        "INSERT INTO security_violations (id, agent_id, reason, created_at) VALUES (?, ?, ?, ?)",
        [id, agentId, reason, now]
      );
    },

    async countByAgent(agentId: string): Promise<number> {
      const row = db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM security_violations WHERE agent_id = ?",
        [agentId]
      );
      return row?.count ?? 0;
    },

    async listByAgent(agentId: string): Promise<SecurityViolationRecord[]> {
      return db.all<SecurityViolationRecord>(
        "SELECT id, agent_id, reason, created_at FROM security_violations WHERE agent_id = ? ORDER BY created_at DESC",
        [agentId]
      );
    },
  };
}
