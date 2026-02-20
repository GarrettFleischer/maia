/**
 * @fileoverview Agent timer repository: CRUD and listDue for scheduler.
 * @module db/timers
 */

import { randomUUID } from "node:crypto";
import type { DbClient } from "./client";

export type AgentTimerRecord = {
  id: string;
  agent_id: string;
  fire_at_ms: number;
  repeat_ms: number;
  created_at: number;
};

export type TimerCreate = {
  agent_id: string;
  fire_at_ms: number;
  repeat_ms: number;
};

export function createTimerRepository(db: DbClient) {
  return {
    async create(input: TimerCreate): Promise<string> {
      const id = randomUUID();
      const now = Date.now();
      db.run(
        "INSERT INTO agent_timers (id, agent_id, fire_at_ms, repeat_ms, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, input.agent_id, input.fire_at_ms, input.repeat_ms, now]
      );
      return id;
    },
    async get(id: string): Promise<AgentTimerRecord | null> {
      const row = db.get<AgentTimerRecord>(
        "SELECT * FROM agent_timers WHERE id = ?",
        [id]
      );
      return row ?? null;
    },
    async listDue(nowMs: number): Promise<AgentTimerRecord[]> {
      return db.all<AgentTimerRecord>(
        "SELECT * FROM agent_timers WHERE fire_at_ms <= ? ORDER BY fire_at_ms ASC",
        [nowMs]
      );
    },
    async listByAgent(agentId: string): Promise<AgentTimerRecord[]> {
      return db.all<AgentTimerRecord>(
        "SELECT * FROM agent_timers WHERE agent_id = ? ORDER BY fire_at_ms ASC",
        [agentId]
      );
    },
    async listAll(): Promise<AgentTimerRecord[]> {
      return db.all<AgentTimerRecord>(
        "SELECT * FROM agent_timers ORDER BY fire_at_ms ASC"
      );
    },
    async updateNextFire(id: string, nextFireAtMs: number): Promise<void> {
      db.run("UPDATE agent_timers SET fire_at_ms = ? WHERE id = ?", [
        nextFireAtMs,
        id,
      ]);
    },
    async delete(id: string): Promise<void> {
      db.run("DELETE FROM agent_timers WHERE id = ?", [id]);
    },
  };
}
