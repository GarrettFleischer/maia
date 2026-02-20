/**
 * @fileoverview Tests for conversation and message repositories.
 * @module tests/db/conversations.test
 */

import { describe, expect, it } from "bun:test";
import { openDb } from "@/db/client";
import { createConversationRepository } from "@/db/conversations";
import { createMessageRepository } from "@/db/messages";

describe("conversation repository", () => {
  it("create and get conversation", async () => {
    const db = await openDb(":memory:");
    const repo = createConversationRepository(db);
    const id = await repo.create("agent-1", "user_chat", null);
    expect(id).toBeDefined();
    const conv = await repo.get(id);
    expect(conv).not.toBeNull();
    expect(conv?.agent_id).toBe("agent-1");
    expect(conv?.type).toBe("user_chat");
    expect(conv?.participant_agent_id).toBeNull();
    db.close();
  });

  it("listByAgent returns conversations for agent", async () => {
    const db = await openDb(":memory:");
    const repo = createConversationRepository(db);
    await repo.create("agent-1", "user_chat", null);
    await repo.create("agent-1", "agent_chat", "agent-2");
    await repo.create("agent-2", "user_chat", null);
    const list = await repo.listByAgent("agent-1");
    expect(list.length).toBe(2);
    db.close();
  });

  it("getOrCreate returns existing or creates", async () => {
    const db = await openDb(":memory:");
    const repo = createConversationRepository(db);
    const id1 = await repo.getOrCreate("agent-1", "internal", null);
    const id2 = await repo.getOrCreate("agent-1", "internal", null);
    expect(id1).toBe(id2);
    const id3 = await repo.getOrCreate("agent-1", "agent_chat", "agent-2");
    const id4 = await repo.getOrCreate("agent-1", "agent_chat", "agent-2");
    expect(id3).toBe(id4);
    expect(id1).not.toBe(id3);
    db.close();
  });
});

describe("message repository", () => {
  it("append and list messages", async () => {
    const db = await openDb(":memory:");
    const convRepo = createConversationRepository(db);
    const convId = await convRepo.create("agent-1", "user_chat", null);
    const msgRepo = createMessageRepository(db);
    const crypto = await import("node:crypto");
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    await msgRepo.append(convId, { type: "user", role: "user", content: "Hello" }, id1);
    await msgRepo.append(convId, { type: "assistant", role: "assistant", content: "Hi" }, id2);
    const messages = await msgRepo.listByConversation(convId);
    expect(messages.length).toBe(2);
    expect(messages[0].type).toBe("user");
    expect(messages[0].content).toBe("Hello");
    expect(messages[1].content).toBe("Hi");
    db.close();
  });

  it("stores tool_call and tool_result", async () => {
    const db = await openDb(":memory:");
    const convRepo = createConversationRepository(db);
    const convId = await convRepo.create("agent-1", "user_chat", null);
    const msgRepo = createMessageRepository(db);
    const crypto = await import("node:crypto");
    await msgRepo.append(convId, {
      type: "tool_call",
      tool_name: "fs_list",
      tool_args: JSON.stringify({ path: "/" }),
    }, crypto.randomUUID());
    await msgRepo.append(convId, {
      type: "tool_result",
      tool_name: "fs_list",
      tool_result: "[]",
    }, crypto.randomUUID());
    const messages = await msgRepo.listByConversation(convId);
    expect(messages.length).toBe(2);
    expect(messages[0].tool_name).toBe("fs_list");
    expect(messages[1].tool_result).toBe("[]");
    db.close();
  });
});
