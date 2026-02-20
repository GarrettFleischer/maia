/**
 * @fileoverview Permissions repository: record and lookup approval per agent/tool.
 * @module db/permissions
 */

import type { DbClient } from "./client";
import { randomUUID } from "node:crypto";

export type PermissionsRepository = {
  record: (agentId: string, toolName: string, approved: boolean) => Promise<void>;
  /** Returns true/false if set, null if no decision recorded. */
  get: (agentId: string, toolName: string) => Promise<boolean | null>;
};

/**
 * Creates the permissions repository.
 */
export function createPermissionsRepository(db: DbClient): PermissionsRepository {
  return {
    async record(agentId: string, toolName: string, approved: boolean): Promise<void> {
      const id = randomUUID();
      const now = Date.now();
      db.run(
        "INSERT INTO permissions (id, agent_id, tool_name, approved, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, agentId, toolName, approved ? 1 : 0, now]
      );
    },

    async get(agentId: string, toolName: string): Promise<boolean | null> {
      const row = db.get<{ approved: number }>(
        "SELECT approved FROM permissions WHERE agent_id = ? AND tool_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        [agentId, toolName]
      );
      if (row === undefined) return null;
      return row.approved === 1;
    },
  };
}
