/**
 * @fileoverview Unit tests for Tier 3 SQLite vector + FTS storage (Repository pattern).
 * @module tests/unit/memory/store
 */

import { describe, it, expect } from "bun:test";
import { createMemoryStore } from "../../../src/memory/store.js";
import { inMemoryDatabase, mockCryptoProvider, capturingLogger } from "../../helpers/index.js";

describe("Memory Store", () => {
  function makeStore() {
    const db = inMemoryDatabase();
    const crypto = mockCryptoProvider();
    const logger = capturingLogger();
    const store = createMemoryStore({ db, crypto, logger });
    return { store, db };
  }

  it("should store a memory entry", async () => {
    const { store, db } = makeStore();
    const entry = await store.store({
      text: "User prefers dark mode",
      category: "preference",
      importance: 0.9,
    });

    expect(entry.id).toBeDefined();
    expect(entry.text).toBe("User prefers dark mode");
    expect(entry.category).toBe("preference");
    expect(entry.importance).toBe(0.9);
    expect(entry.createdAt).toBeDefined();

    // Should have executed INSERT
    const inserts = db.executedSql.filter((s) => s.sql.includes("INSERT"));
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });

  it("should retrieve a memory by id", async () => {
    const { store } = makeStore();
    const stored = await store.store({
      text: "Test memory",
      category: "fact",
      importance: 0.5,
    });

    const retrieved = await store.get(stored.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.text).toBe("Test memory");
  });

  it("should return null for nonexistent id", async () => {
    const { store } = makeStore();
    const result = await store.get("nonexistent-id");
    expect(result).toBeNull();
  });

  it("should remove a memory by id", async () => {
    const { store, db } = makeStore();
    await store.remove("mem_123");

    const deletes = db.executedSql.filter((s) => s.sql.includes("DELETE"));
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });

  it("should count stored memories", async () => {
    const { store } = makeStore();
    const count = await store.count();
    expect(typeof count).toBe("number");
  });

  it("should search memories", async () => {
    const { store } = makeStore();
    const results = await store.search("dark mode", { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });

  it("should search memories by category", async () => {
    const { store } = makeStore();
    const results = await store.search("test", { category: "preference", limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });
});
