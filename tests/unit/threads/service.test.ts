/**
 * @fileoverview Unit tests for the thread service (getMessagesForParticipantSince and related).
 * @module tests/unit/threads/service
 */

import { describe, it, expect } from "bun:test";
import { createThreadService } from "../../../src/threads/service.js";
import { capturingLogger, mockCryptoProvider, fixedClock } from "../../helpers/index.js";
import type { Database } from "../../../src/core/types.js";

/**
 * Mock DB that supports listThreads (threads with participants LIKE) and messages query by thread_id and since.
 */
function mockThreadDatabase(
  threads: Array<{ id: string; type: string; participants: string[]; created_at: string; updated_at: string }>,
  messages: Array<{ id: string; thread_id: string; sender_id: string; sender_type: string; content: string; created_at: string }>
): Database {
  return {
    async execute(): Promise<void> {},
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const p = params ?? [];
      if (sql.includes("FROM threads")) {
        if (p.length >= 1) {
          const likePattern = p[0] as string;
          const participantId = likePattern.replace(/%/g, "").replace(/"/g, "");
          const out = threads
            .filter((t) => t.participants.includes(participantId))
            .map((t) => ({
              id: t.id,
              type: t.type,
              title: null,
              participants: JSON.stringify(t.participants),
              created_at: t.created_at,
              updated_at: t.updated_at,
            }));
          return out as T[];
        }
        const out = threads.map((t) => ({
          id: t.id,
          type: t.type,
          title: null,
          participants: JSON.stringify(t.participants),
          created_at: t.created_at,
          updated_at: t.updated_at,
        }));
        return out as T[];
      }
      // getLastDmSentAt: JOIN threads t, thread_messages m, type = agent-dm, participants LIKE ?, sender_id = ?
      if (
        sql.includes("thread_messages m") &&
        sql.includes("INNER JOIN threads t") &&
        sql.includes("agent-dm") &&
        p.length >= 2
      ) {
        const likePattern = p[0] as string;
        const agentId = p[1] as string;
        const participantId = likePattern.replace(/%/g, "").replace(/"/g, "");
        const agentDmThreads = threads.filter(
          (t) => t.type === "agent-dm" && t.participants.includes(participantId)
        );
        const agentDmThreadIds = new Set(agentDmThreads.map((t) => t.id));
        const fromAgent = messages
          .filter((m) => agentDmThreadIds.has(m.thread_id) && m.sender_id === agentId)
          .sort((a, b) => (b.created_at < a.created_at ? -1 : 1));
        if (fromAgent.length === 0) return [] as T[];
        return [{ created_at: fromAgent[0].created_at }] as T[];
      }
      if (sql.includes("thread_messages") && sql.includes("created_at")) {
        const threadId = p[0] as string;
        const since = p[1] as string;
        const out = messages
          .filter((m) => m.thread_id === threadId && m.created_at >= since)
          .map((m) => ({
            id: m.id,
            thread_id: m.thread_id,
            sender_id: m.sender_id,
            sender_type: m.sender_type,
            content: m.content,
            created_at: m.created_at,
          }));
        return out as T[];
      }
      return [];
    },
    async close(): Promise<void> {},
  };
}

describe("ThreadService", () => {
  describe("getMessagesForParticipantSince", () => {
    it("should return empty array when participant has no threads", async () => {
      const db = mockThreadDatabase([], []);
      const service = createThreadService({
        db,
        crypto: mockCryptoProvider(),
        clock: fixedClock(),
        logger: capturingLogger(),
      });
      const result = await service.getMessagesForParticipantSince("agent-1", "2026-02-13T10:00:00.000Z");
      expect(result).toEqual([]);
    });

    it("should return threads and messages since timestamp", async () => {
      const db = mockThreadDatabase(
        [
          {
            id: "thread-1",
            type: "user-agent",
            participants: ["user", "agent-1"],
            created_at: "2026-02-13T09:00:00.000Z",
            updated_at: "2026-02-13T12:00:00.000Z",
          },
        ],
        [
          {
            id: "msg-1",
            thread_id: "thread-1",
            sender_id: "user",
            sender_type: "user",
            content: "Hello",
            created_at: "2026-02-13T11:00:00.000Z",
          },
          {
            id: "msg-2",
            thread_id: "thread-1",
            sender_id: "agent-1",
            sender_type: "agent",
            content: "Hi there",
            created_at: "2026-02-13T11:01:00.000Z",
          },
        ]
      );
      const service = createThreadService({
        db,
        crypto: mockCryptoProvider(),
        clock: fixedClock(),
        logger: capturingLogger(),
      });
      const result = await service.getMessagesForParticipantSince("agent-1", "2026-02-13T10:00:00.000Z");
      expect(result).toHaveLength(1);
      expect(result[0].threadId).toBe("thread-1");
      expect(result[0].threadType).toBe("user-agent");
      expect(result[0].messages).toHaveLength(2);
      expect(result[0].messages[0].content).toBe("Hello");
      expect(result[0].messages[1].content).toBe("Hi there");
    });

    it("should exclude messages before since timestamp", async () => {
      const db = mockThreadDatabase(
        [
          {
            id: "t1",
            type: "user-agent",
            participants: ["user", "agent-1"],
            created_at: "2026-02-13T09:00:00.000Z",
            updated_at: "2026-02-13T12:00:00.000Z",
          },
        ],
        [
          {
            id: "m1",
            thread_id: "t1",
            sender_id: "user",
            sender_type: "user",
            content: "Old",
            created_at: "2026-02-13T09:00:00.000Z",
          },
          {
            id: "m2",
            thread_id: "t1",
            sender_id: "user",
            sender_type: "user",
            content: "New",
            created_at: "2026-02-13T11:00:00.000Z",
          },
        ]
      );
      const service = createThreadService({
        db,
        crypto: mockCryptoProvider(),
        clock: fixedClock(),
        logger: capturingLogger(),
      });
      const result = await service.getMessagesForParticipantSince("agent-1", "2026-02-13T10:00:00.000Z");
      expect(result).toHaveLength(1);
      expect(result[0].messages).toHaveLength(1);
      expect(result[0].messages[0].content).toBe("New");
      expect(result[0].messages[0].createdAt).toBe("2026-02-13T11:00:00.000Z");
    });
  });

  describe("getLastDmSentAt", () => {
    it("returns null when agent has no messages in agent-dm threads", async () => {
      const db = mockThreadDatabase(
        [
          {
            id: "dm-1",
            type: "agent-dm",
            participants: ["maia", "agent-1"],
            created_at: "2026-02-13T09:00:00.000Z",
            updated_at: "2026-02-13T12:00:00.000Z",
          },
        ],
        [
          {
            id: "m1",
            thread_id: "dm-1",
            sender_id: "maia",
            sender_type: "maia",
            content: "Only Maia sent",
            created_at: "2026-02-13T10:00:00.000Z",
          },
        ]
      );
      const service = createThreadService({
        db,
        crypto: mockCryptoProvider(),
        clock: fixedClock(),
        logger: capturingLogger(),
      });
      const result = await service.getLastDmSentAt("agent-1");
      expect(result).toBeNull();
    });

    it("returns latest message created_at when agent sent in agent-dm thread", async () => {
      const db = mockThreadDatabase(
        [
          {
            id: "dm-1",
            type: "agent-dm",
            participants: ["maia", "agent-1"],
            created_at: "2026-02-13T09:00:00.000Z",
            updated_at: "2026-02-13T12:00:00.000Z",
          },
        ],
        [
          {
            id: "m1",
            thread_id: "dm-1",
            sender_id: "agent-1",
            sender_type: "agent",
            content: "First",
            created_at: "2026-02-13T10:00:00.000Z",
          },
          {
            id: "m2",
            thread_id: "dm-1",
            sender_id: "agent-1",
            sender_type: "agent",
            content: "Second",
            created_at: "2026-02-13T11:00:00.000Z",
          },
        ]
      );
      const service = createThreadService({
        db,
        crypto: mockCryptoProvider(),
        clock: fixedClock(),
        logger: capturingLogger(),
      });
      const result = await service.getLastDmSentAt("agent-1");
      expect(result).toBe("2026-02-13T11:00:00.000Z");
    });

    it("ignores non-agent-dm threads", async () => {
      const db = mockThreadDatabase(
        [
          {
            id: "user-agent-1",
            type: "user-agent",
            participants: ["user", "agent-1"],
            created_at: "2026-02-13T09:00:00.000Z",
            updated_at: "2026-02-13T12:00:00.000Z",
          },
        ],
        [
          {
            id: "m1",
            thread_id: "user-agent-1",
            sender_id: "agent-1",
            sender_type: "agent",
            content: "In user-agent thread",
            created_at: "2026-02-13T11:00:00.000Z",
          },
        ]
      );
      const service = createThreadService({
        db,
        crypto: mockCryptoProvider(),
        clock: fixedClock(),
        logger: capturingLogger(),
      });
      const result = await service.getLastDmSentAt("agent-1");
      expect(result).toBeNull();
    });
  });
});
