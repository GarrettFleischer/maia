/**
 * @fileoverview Integration test for MemoryStore with real SQLite + real crypto.
 * @module tests/integration/memory-store
 *
 * @note Uses real bun:sqlite :memory: with the actual schema applied,
 * plus real CryptoProvider for UUID generation. Proves CRUD operations
 * and text search work against a real database.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "node:path";
import * as fsNative from "node:fs/promises";
import { createSQLiteDatabase } from "../../src/adapters/database.js";
import { createRealCryptoProvider } from "../../src/adapters/crypto.js";
import { createMemoryStore } from "../../src/memory/store.js";
import { capturingLogger } from "../helpers/index.js";
import type { Database } from "../../src/core/types.js";

describe("MemoryStore with real SQLite (integration)", () => {
  let db: Database;

  beforeEach(async () => {
    db = createSQLiteDatabase(":memory:");

    // Apply the real schema (001 + 002 for agent_id on memories)
    const sqlPath1 = path.resolve(
      "src/core/migrations/migrations/001_initial_schema.sql",
    );
    const sql1 = await fsNative.readFile(sqlPath1, "utf-8");
    await db.execute(sql1);
    const sqlPath2 = path.resolve(
      "src/core/migrations/migrations/002_add_agents.sql",
    );
    const sql2 = await fsNative.readFile(sqlPath2, "utf-8");
    await db.execute(sql2);
  });

  /**
   * @brief Helper to create a real memory store.
   */
  function createStore() {
    const crypto = createRealCryptoProvider();
    const logger = capturingLogger();
    return { store: createMemoryStore({ db, crypto, logger }), crypto, logger };
  }

  // ── store ────────────────────────────────────────────────────────

  it("should store a memory entry and return it with id", async () => {
    const { store } = createStore();
    const entry = await store.store({
      text: "User prefers dark mode",
      category: "preference",
      importance: 0.8,
    });

    expect(entry.id).toBeTruthy();
    expect(entry.text).toBe("User prefers dark mode");
    expect(entry.category).toBe("preference");
    expect(entry.importance).toBe(0.8);
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBeTruthy();
  });

  // ── get ──────────────────────────────────────────────────────────

  it("should retrieve a stored memory by id", async () => {
    const { store } = createStore();
    const created = await store.store({
      text: "Bun is fast",
      category: "fact",
      importance: 0.6,
    });

    const fetched = await store.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.text).toBe("Bun is fast");
    expect(fetched!.category).toBe("fact");
  });

  it("should return null for non-existent id", async () => {
    const { store } = createStore();
    const result = await store.get("non-existent-id");
    expect(result).toBeNull();
  });

  // ── search (LIKE-based) ──────────────────────────────────────────

  it("should find memories matching a text query", async () => {
    const { store } = createStore();
    await store.store({
      text: "User likes TypeScript and Bun",
      category: "preference",
      importance: 0.9,
    });
    await store.store({
      text: "The weather is sunny today",
      category: "fact",
      importance: 0.3,
    });
    await store.store({
      text: "TypeScript has great type inference",
      category: "fact",
      importance: 0.7,
    });

    const results = await store.search("TypeScript");
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      expect(r.entry.text.toLowerCase()).toContain("typescript");
    }
  });

  it("should filter search by category", async () => {
    const { store } = createStore();
    await store.store({
      text: "User likes dark mode",
      category: "preference",
      importance: 0.8,
    });
    await store.store({
      text: "Dark mode saves battery",
      category: "fact",
      importance: 0.5,
    });

    const results = await store.search("dark", { category: "preference" });
    expect(results).toHaveLength(1);
    expect(results[0].entry.category).toBe("preference");
  });

  it("should respect limit in search", async () => {
    const { store } = createStore();
    for (let i = 0; i < 10; i++) {
      await store.store({
        text: `Memory item number ${i}`,
        category: "fact",
        importance: 0.5,
      });
    }

    const results = await store.search("Memory", { limit: 3 });
    expect(results).toHaveLength(3);
  });

  // ── count ────────────────────────────────────────────────────────

  it("should return correct count", async () => {
    const { store } = createStore();
    expect(await store.count()).toBe(0);

    await store.store({ text: "First", category: "fact", importance: 0.5 });
    expect(await store.count()).toBe(1);

    await store.store({ text: "Second", category: "fact", importance: 0.5 });
    expect(await store.count()).toBe(2);
  });

  // ── remove ───────────────────────────────────────────────────────

  it("should remove a memory by id", async () => {
    const { store } = createStore();
    const entry = await store.store({
      text: "To be deleted",
      category: "other",
      importance: 0.1,
    });
    expect(await store.count()).toBe(1);

    await store.remove(entry.id);
    expect(await store.count()).toBe(0);

    const result = await store.get(entry.id);
    expect(result).toBeNull();
  });

  // ── ordering ─────────────────────────────────────────────────────

  it("should return search results ordered by importance descending", async () => {
    const { store } = createStore();
    await store.store({
      text: "Low importance item",
      category: "fact",
      importance: 0.2,
    });
    await store.store({
      text: "High importance item",
      category: "fact",
      importance: 0.9,
    });
    await store.store({
      text: "Medium importance item",
      category: "fact",
      importance: 0.5,
    });

    const results = await store.search("importance");
    expect(results[0].entry.importance).toBe(0.9);
    expect(results[1].entry.importance).toBe(0.5);
    expect(results[2].entry.importance).toBe(0.2);
  });
});
