/**
 * @fileoverview Conversation repository: create, get, list by agent.
 * @module db/conversations
 */

import type { DbClient } from "./client";
import { randomUUID } from "node:crypto";

export type ConversationRecord = {
  id: string;
  agent_id: string;
  type: string;
  participant_agent_id: string | null;
  created_at: number;
  updated_at: number;
};

export type ConversationRepository = {
  create: (agentId: string, type: string, participantAgentId: string | null) => Promise<string>;
  get: (id: string) => Promise<ConversationRecord | null>;
  listByAgent: (agentId: string) => Promise<ConversationRecord[]>;
  /** Find existing or create; returns conversation id. */
  getOrCreate: (
    agentId: string,
    type: string,
    participantAgentId: string | null
  ) => Promise<string>;
};

/**
 * Creates the conversation repository.
 */
export function createConversationRepository(db: DbClient): ConversationRepository {
  return {
    async create(
      agentId: string,
      type: string,
      participantAgentId: string | null
    ): Promise<string> {
      const id = randomUUID();
      const now = Date.now();
      db.run(
        "INSERT INTO conversations (id, agent_id, type, participant_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [id, agentId, type, participantAgentId ?? null, now, now]
      );
      return id;
    },

    async get(id: string): Promise<ConversationRecord | null> {
      const row = db.get<ConversationRecord>(
        "SELECT * FROM conversations WHERE id = ?",
        [id]
      );
      return row ?? null;
    },

    async listByAgent(agentId: string): Promise<ConversationRecord[]> {
      return db.all<ConversationRecord>(
        "SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC",
        [agentId]
      );
    },

    async getOrCreate(
      agentId: string,
      type: string,
      participantAgentId: string | null
    ): Promise<string> {
      const p = participantAgentId ?? "";
      const existing = db.get<{ id: string }>(
        "SELECT id FROM conversations WHERE agent_id = ? AND type = ? AND ((? = '' AND participant_agent_id IS NULL) OR participant_agent_id = ?) LIMIT 1",
        [agentId, type, p, p]
      );
      if (existing?.id) return existing.id;
      return this.create(agentId, type, participantAgentId);
    },
  };
}
