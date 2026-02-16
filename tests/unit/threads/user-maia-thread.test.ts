/**
 * @fileoverview Unit tests for user-maia thread flow: findOrCreateThread and addMessage.
 * @module tests/unit/threads/user-maia-thread
 *
 * @brief Verifies the thread persistence used when the user chats with Maia via
 * thread_message (DM thread): user message and Maia reply are both stored.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { createThreadService } from "../../../src/threads/service.js";
import { capturingLogger, mockCryptoProvider, fixedClock } from "../../helpers/index.js";
import { createSQLiteDatabase } from "../../../src/adapters/database.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function createTestDb(): Promise<ReturnType<typeof createSQLiteDatabase>> {
  const db = createSQLiteDatabase(":memory:");
  const sql003 = await fs.readFile(
    path.resolve("src/core/migrations/migrations/003_add_threads.sql"),
    "utf-8"
  );
  await db.execute(sql003);
  const sql011 = await fs.readFile(
    path.resolve("src/core/migrations/migrations/011_add_thread_message_kind.sql"),
    "utf-8"
  );
  for (const stmt of sql011.split(";").filter((s) => s.trim())) {
    if (stmt.trim()) await db.execute(stmt.trim() + ";");
  }
  return db;
}

describe("User-Maia thread (DM persistence)", () => {
  let db: ReturnType<typeof createSQLiteDatabase>;
  let threadService: ReturnType<typeof createThreadService>;

  beforeAll(async () => {
    db = await createTestDb();
    threadService = createThreadService({
      db,
      crypto: mockCryptoProvider(),
      clock: fixedClock(),
      logger: capturingLogger(),
    });
  });

  it("findOrCreateThread creates user-maia thread and addMessage stores user then maia reply", async () => {
    const thread = await threadService.findOrCreateThread(
      "user-maia",
      ["user", "maia"],
      "Chat"
    );
    expect(thread.type).toBe("user-maia");
    expect(thread.participants).toEqual(["maia", "user"]);

    await threadService.addMessage(thread.id, "user", "user", "Hello Maia");
    await threadService.addMessage(thread.id, "maia", "maia", "Hi! How can I help?");

    const messages = await threadService.getMessages(thread.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].senderId).toBe("user");
    expect(messages[0].senderType).toBe("user");
    expect(messages[0].content).toBe("Hello Maia");
    expect(messages[1].senderId).toBe("maia");
    expect(messages[1].senderType).toBe("maia");
    expect(messages[1].content).toBe("Hi! How can I help?");
  });

  it("findOrCreateThread returns same thread when called again with same type and participants", async () => {
    const thread1 = await threadService.findOrCreateThread(
      "user-maia",
      ["maia", "user"],
      "Chat"
    );
    const thread2 = await threadService.findOrCreateThread(
      "user-maia",
      ["user", "maia"],
      "Chat"
    );
    expect(thread1.id).toBe(thread2.id);
  });
});
