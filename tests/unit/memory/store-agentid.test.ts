/**
 * @fileoverview Unit tests for agentId scoping in memory store.
 * @module tests/unit/memory/store-agentid
 *
 * @note These tests focus specifically on the agentId partitioning.
 * General memory store CRUD is covered by the existing store.test.ts.
 */

import { describe, it, expect } from "bun:test";
import { createMemoryStore } from "../../../src/memory/store.js";
import {
  inMemoryDatabase,
  mockCryptoProvider,
  capturingLogger,
} from "../../helpers/index.js";

function makeStore(agentId?: string) {
  const db = inMemoryDatabase();
  const crypto = mockCryptoProvider();
  const logger = capturingLogger();
  const store = createMemoryStore({ db, crypto, logger, agentId });
  return { store, db, crypto, logger };
}

describe("MemoryStore agentId scoping", () => {
  it("should default agentId to 'maia'", async () => {
    const { store, db } = makeStore();

    await store.store({
      text: "Test memory",
      category: "fact",
      importance: 0.8,
    });

    const insertSql = db.executedSql.find((s) => s.sql.includes("INSERT INTO memories"));
    expect(insertSql).toBeDefined();
    // agentId is the last param (index 8)
    expect(insertSql!.params![8]).toBe("maia");
  });

  it("should use custom agentId when provided", async () => {
    const { store, db } = makeStore("research-bot");

    await store.store({
      text: "Agent-specific memory",
      category: "fact",
      importance: 0.7,
    });

    const insertSql = db.executedSql.find((s) => s.sql.includes("INSERT INTO memories"));
    expect(insertSql!.params![8]).toBe("research-bot");
  });

  it("should scope search by agentId", async () => {
    const { store, db } = makeStore("my-agent");

    await store.search("test query");

    const searchSql = db.executedSql.find((s) => s.sql.includes("SELECT") && s.sql.includes("agent_id"));
    expect(searchSql).toBeDefined();
    expect(searchSql!.params![0]).toBe("my-agent");
  });

  it("should scope remove by agentId", async () => {
    const { store, db } = makeStore("my-agent");

    await store.remove("some-id");

    const deleteSql = db.executedSql.find((s) => s.sql.includes("DELETE") && s.sql.includes("agent_id"));
    expect(deleteSql).toBeDefined();
    expect(deleteSql!.params!).toContain("my-agent");
  });

  it("should scope count by agentId", async () => {
    const { store, db } = makeStore("my-agent");

    await store.count();

    const countSql = db.executedSql.find((s) => s.sql.includes("COUNT") && s.sql.includes("agent_id"));
    expect(countSql).toBeDefined();
    expect(countSql!.params![0]).toBe("my-agent");
  });

  it("should provide cross-agent isolation", async () => {
    const db = inMemoryDatabase();
    const crypto = mockCryptoProvider();
    const logger = capturingLogger();

    const storeA = createMemoryStore({ db, crypto, logger, agentId: "agent-a" });
    const storeB = createMemoryStore({ db, crypto, logger, agentId: "agent-b" });

    await storeA.store({ text: "Memory A", category: "fact", importance: 0.8 });
    await storeB.store({ text: "Memory B", category: "fact", importance: 0.7 });

    // Each store's INSERT should use its own agentId
    const inserts = db.executedSql.filter((s) => s.sql.includes("INSERT INTO memories"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params![8]).toBe("agent-a");
    expect(inserts[1].params![8]).toBe("agent-b");
  });

  it("should not scope get by agentId (documents current behavior)", async () => {
    const { store, db } = makeStore("my-agent");

    await store.get("some-id");

    // The get query uses WHERE id = ? only, no agent_id filter
    const getSql = db.executedSql.find((s) => s.sql.includes("SELECT") && s.sql.includes("WHERE id"));
    expect(getSql).toBeDefined();
    expect(getSql!.params).toEqual(["some-id"]);
  });
});
