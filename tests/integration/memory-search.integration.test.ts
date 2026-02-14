/**
 * @fileoverview Integration test for hybrid search with real SQLite.
 * @module tests/integration/memory-search
 *
 * @note Runs createHybridSearch against a real DB with the memories schema
 * so the full LIKE/category/limit SQL path is executed.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "node:path";
import * as fsNative from "node:fs/promises";
import { createSQLiteDatabase } from "../../src/adapters/database.js";
import { createRealCryptoProvider } from "../../src/adapters/crypto.js";
import { createMemoryStore } from "../../src/memory/store.js";
import { createHybridSearch } from "../../src/memory/search.js";
import { capturingLogger } from "../helpers/index.js";
import type { Database } from "../../src/core/types.js";

describe("HybridSearch with real SQLite (integration)", () => {
  let db: Database;

  beforeEach(async () => {
    db = createSQLiteDatabase(":memory:");
    const sqlPath = path.resolve("src/core/migrations/migrations/001_initial_schema.sql");
    const sql = await fsNative.readFile(sqlPath, "utf-8");
    await db.execute(sql);
  });

  it("should return matching results via hybrid search", async () => {
    const crypto = createRealCryptoProvider();
    const logger = capturingLogger();
    const store = createMemoryStore({ db, crypto, logger });
    await store.store({
      text: "User prefers TypeScript",
      category: "preference",
      importance: 0.9,
    });
    await store.store({
      text: "Bun is fast",
      category: "fact",
      importance: 0.5,
    });

    const search = createHybridSearch({
      db,
      logger,
      vectorWeight: 0.7,
      textWeight: 0.3,
    });
    const results = await search.search("TypeScript", {
      embedding: new Array(64).fill(0.1),
      limit: 5,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entry.text).toContain("TypeScript");
  });

  it("should filter by category", async () => {
    const crypto = createRealCryptoProvider();
    const logger = capturingLogger();
    const store = createMemoryStore({ db, crypto, logger });
    await store.store({ text: "Preference one", category: "preference", importance: 0.8 });
    await store.store({ text: "Fact one", category: "fact", importance: 0.5 });

    const search = createHybridSearch({
      db,
      logger,
      vectorWeight: 0.7,
      textWeight: 0.3,
    });
    const results = await search.search("one", {
      embedding: new Array(64).fill(0),
      limit: 5,
      category: "preference",
    });
    expect(results).toHaveLength(1);
    expect(results[0].entry.category).toBe("preference");
  });

  it("should respect limit", async () => {
    const crypto = createRealCryptoProvider();
    const logger = capturingLogger();
    const store = createMemoryStore({ db, crypto, logger });
    for (let i = 0; i < 10; i++) {
      await store.store({
        text: `Item ${i} match`,
        category: "fact",
        importance: 0.5,
      });
    }

    const search = createHybridSearch({
      db,
      logger,
      vectorWeight: 0.7,
      textWeight: 0.3,
    });
    const results = await search.search("match", {
      embedding: new Array(64).fill(0),
      limit: 3,
    });
    expect(results).toHaveLength(3);
  });
});
