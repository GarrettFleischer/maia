/**
 * @fileoverview Agent repository: CRUD and all agent .md files + workspace on create.
 * @module db/agents
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { AGENT_MD_FILES, DEFAULT_MD_CONTENT, MAIA_INITIAL_HEARTBEAT } from "@/agent/context-files";
import type { DbClient } from "./client";

/** Reserved agent id for the built-in Maia assistant. */
export const MAIA_AGENT_ID = "maia";

export type AgentRecord = {
  id: string;
  name: string;
  model: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
};

export type AgentCreate = {
  /** Optional fixed id (e.g. MAIA_AGENT_ID); if omitted a UUID is used. */
  id?: string;
  name: string;
  purpose: string;
  model?: string | null;
};

export type AgentUpdate = Partial<Pick<AgentRecord, "name" | "model" | "enabled">>;

export type FsDeps = {
  mkdir: (path: string) => void;
  writeFile: (path: string, content: string) => void;
};

/**
 * Creates an agent repository.
 * @param db - SQLite client
 * @param sandboxRoot - Root path for agent dirs (~/.maia)
 * @param fs - FS operations for writing agent .md files and workspace dir
 */
export function createAgentRepository(
  db: DbClient,
  sandboxRoot: string,
  fs: FsDeps
) {
  return {
    async create(input: AgentCreate): Promise<AgentRecord> {
      const id = input.id ?? randomUUID();
      const now = Date.now();
      const agentDir = path.join(sandboxRoot, id);
      fs.mkdir(agentDir);
      const workspacePath = path.join(agentDir, "workspace");
      fs.mkdir(workspacePath);
      const identityContent = input.purpose.trim() || "# Purpose\n\n" + input.name;
      const heartbeatContent =
        id === MAIA_AGENT_ID ? MAIA_INITIAL_HEARTBEAT : DEFAULT_MD_CONTENT["HEARTBEAT.md"];
      for (const name of AGENT_MD_FILES) {
        const full = path.join(agentDir, name);
        const content =
          name === "IDENTITY.md"
            ? identityContent
            : name === "HEARTBEAT.md"
              ? heartbeatContent
              : DEFAULT_MD_CONTENT[name];
        fs.writeFile(full, content);
      }
      db.run(
        "INSERT INTO agents (id, name, model, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
        [id, input.name.trim(), input.model ?? null, now, now]
      );
      const row = db.get<AgentRecord>("SELECT * FROM agents WHERE id = ?", [id]);
      if (!row) throw new Error("Agent insert failed");
      return row as AgentRecord;
    },
    async get(id: string): Promise<AgentRecord | null> {
      const row = db.get<AgentRecord>("SELECT * FROM agents WHERE id = ?", [id]);
      return row ?? null;
    },
    async list(): Promise<AgentRecord[]> {
      return db.all<AgentRecord>("SELECT * FROM agents ORDER BY created_at ASC");
    },
    async update(id: string, patch: AgentUpdate): Promise<void> {
      const now = Date.now();
      if (patch.name !== undefined) {
        db.run("UPDATE agents SET name = ?, updated_at = ? WHERE id = ?", [
          patch.name,
          now,
          id,
        ]);
      }
      if (patch.model !== undefined) {
        db.run("UPDATE agents SET model = ?, updated_at = ? WHERE id = ?", [
          patch.model,
          now,
          id,
        ]);
      }
      if (patch.enabled !== undefined) {
        db.run("UPDATE agents SET enabled = ?, updated_at = ? WHERE id = ?", [
          patch.enabled,
          now,
          id,
        ]);
      }
    },
    async delete(id: string): Promise<void> {
      db.run("DELETE FROM agents WHERE id = ?", [id]);
    },
  };
}
