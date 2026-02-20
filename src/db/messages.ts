/**
 * @fileoverview Message repository: append and list by conversation.
 * @module db/messages
 */

import type { DbClient } from "./client";

export type MessagePayload = {
  type: string;
  role?: string;
  content?: string | null;
  tool_name?: string | null;
  tool_args?: string | null;
  tool_result?: string | null;
};

export type MessageRecord = {
  id: string;
  conversation_id: string;
  type: string;
  role: string | null;
  content: string | null;
  tool_name: string | null;
  tool_args: string | null;
  tool_result: string | null;
  created_at: number;
};

export type MessageRepository = {
  append: (conversationId: string, payload: MessagePayload, id: string) => Promise<void>;
  listByConversation: (conversationId: string) => Promise<MessageRecord[]>;
};

/**
 * Creates the message repository.
 */
export function createMessageRepository(db: DbClient): MessageRepository {
  return {
    async append(
      conversationId: string,
      payload: MessagePayload,
      id: string
    ): Promise<void> {
      const now = Date.now();
      db.run(
        "INSERT INTO messages (id, conversation_id, type, role, content, tool_name, tool_args, tool_result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          conversationId,
          payload.type,
          payload.role ?? null,
          payload.content ?? null,
          payload.tool_name ?? null,
          payload.tool_args ?? null,
          payload.tool_result ?? null,
          now,
        ]
      );
    },

    async listByConversation(conversationId: string): Promise<MessageRecord[]> {
      return db.all<MessageRecord>(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
        [conversationId]
      );
    },
  };
}
