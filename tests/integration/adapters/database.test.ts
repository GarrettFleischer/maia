/**
 * @fileoverview Integration tests for the real database adapter.
 * @module tests/integration/adapters/database
 *
 * @note Uses bun:sqlite with :memory: so no files are created on disk.
 * Also validates that the real 001_initial_schema.sql is valid SQL.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fsNative from "node:fs/promises";
import * as path from "node:path";
import { createSQLiteDatabase } from "../../../src/adapters/database.js";

describe("Real SQLite Database adapter", () => {
  const databases: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const db of databases) {
      try {
        await db.close();
      } catch {
        // Already closed is fine
      }
    }
    databases.length = 0;
  });

  /**
   * @brief Helper to create a tracked in-memory database.
   */
  function createTestDB() {
    const db = createSQLiteDatabase(":memory:");
    databases.push(db);
    return db;
  }

  // ── execute ──────────────────────────────────────────────────────

  it("should execute CREATE TABLE without error", async () => {
    const db = createTestDB();
    await expect(
      db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    ).resolves.toBeUndefined();
  });

  it("should execute INSERT with params", async () => {
    const db = createTestDB();
    await db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    await expect(
      db.execute("INSERT INTO test (name) VALUES (?)", ["Alice"])
    ).resolves.toBeUndefined();
  });

  // ── query ────────────────────────────────────────────────────────

  it("should query rows with correct types", async () => {
    const db = createTestDB();
    await db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)");
    await db.execute("INSERT INTO users (name, age) VALUES (?, ?)", ["Bob", 30]);
    await db.execute("INSERT INTO users (name, age) VALUES (?, ?)", ["Carol", 25]);

    const rows = await db.query<{ id: number; name: string; age: number }>(
      "SELECT id, name, age FROM users ORDER BY age"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("Carol");
    expect(rows[0].age).toBe(25);
    expect(rows[1].name).toBe("Bob");
    expect(rows[1].age).toBe(30);
  });

  it("should query with params", async () => {
    const db = createTestDB();
    await db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
    await db.execute("INSERT INTO items (label) VALUES (?)", ["alpha"]);
    await db.execute("INSERT INTO items (label) VALUES (?)", ["beta"]);

    const rows = await db.query<{ label: string }>(
      "SELECT label FROM items WHERE label = ?",
      ["beta"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("beta");
  });

  it("should return empty array for no matches", async () => {
    const db = createTestDB();
    await db.execute("CREATE TABLE empty_test (id INTEGER PRIMARY KEY)");
    const rows = await db.query<{ id: number }>("SELECT id FROM empty_test");
    expect(rows).toEqual([]);
  });

  // ── close ────────────────────────────────────────────────────────

  it("should close without error", async () => {
    const db = createTestDB();
    await expect(db.close()).resolves.toBeUndefined();
  });

  // ── Real migration SQL ───────────────────────────────────────────

  it("should execute the real 001_initial_schema.sql successfully", async () => {
    const db = createTestDB();
    const sqlPath = path.resolve("src/core/migrations/migrations/001_initial_schema.sql");
    const sql = await fsNative.readFile(sqlPath, "utf-8");

    // The migration SQL should execute without errors
    await expect(db.execute(sql)).resolves.toBeUndefined();

    // Verify tables were created
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("schema_version");
  });

  it("should support FTS5 queries after applying migration", async () => {
    const db = createTestDB();
    const sqlPath = path.resolve("src/core/migrations/migrations/001_initial_schema.sql");
    const sql = await fsNative.readFile(sqlPath, "utf-8");
    await db.execute(sql);

    // Insert a memory
    await db.execute(
      `INSERT INTO memories (id, text, category, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["test-1", "The user prefers dark mode themes", "preference", 0.8, "2026-01-01", "2026-01-01"]
    );

    // FTS5 sync trigger: manually insert into FTS
    await db.execute(
      "INSERT INTO memories_fts (rowid, text) VALUES ((SELECT rowid FROM memories WHERE id = ?), ?)",
      ["test-1", "The user prefers dark mode themes"]
    );

    // Query FTS5
    const results = await db.query<{ text: string }>(
      "SELECT m.text FROM memories m JOIN memories_fts fts ON m.rowid = fts.rowid WHERE memories_fts MATCH ?",
      ["dark mode"]
    );
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("dark mode");
  });
});
