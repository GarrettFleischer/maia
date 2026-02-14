/**
 * @fileoverview Integration test for the migration runner with real SQLite.
 * @module tests/integration/migrations
 *
 * @note Uses real bun:sqlite :memory: + real filesystem (temp dir with .sql files)
 * to prove the migration SQL is valid and the runner correctly tracks versions.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsNative from "node:fs/promises";
import { createSQLiteDatabase } from "../../src/adapters/database.js";
import { createRealFileSystem } from "../../src/adapters/filesystem.js";
import { createMigrationRunner } from "../../src/core/migrations/runner.js";
import { capturingLogger } from "../helpers/index.js";

describe("Migration runner with real SQLite (integration)", () => {
  const tmpDir = path.join(os.tmpdir(), `maia-migration-test-${Date.now()}`);
  const migrationsDir = path.join(tmpDir, "migrations");
  const realFs = createRealFileSystem();

  beforeAll(async () => {
    await fsNative.mkdir(migrationsDir, { recursive: true });

    // Copy the real migration SQL to the temp dir
    const sqlPath = path.resolve("src/core/migrations/migrations/001_initial_schema.sql");
    const sql = await fsNative.readFile(sqlPath, "utf-8");
    await fsNative.writeFile(path.join(migrationsDir, "001_initial_schema.sql"), sql);
  });

  afterAll(async () => {
    await fsNative.rm(tmpDir, { recursive: true, force: true });
  });

  it("should create schema_version table", async () => {
    const db = createSQLiteDatabase(":memory:");
    const logger = capturingLogger();
    const runner = createMigrationRunner({ db, fs: realFs, logger, migrationsPath: migrationsDir });

    await runner.run();

    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    );
    expect(tables).toHaveLength(1);
    await db.close();
  });

  it("should apply 001_initial_schema.sql and create memories table", async () => {
    const db = createSQLiteDatabase(":memory:");
    const logger = capturingLogger();
    const runner = createMigrationRunner({ db, fs: realFs, logger, migrationsPath: migrationsDir });

    await runner.run();

    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("schema_version");
    await db.close();
  });

  it("should create the FTS5 virtual table", async () => {
    const db = createSQLiteDatabase(":memory:");
    const logger = capturingLogger();
    const runner = createMigrationRunner({ db, fs: realFs, logger, migrationsPath: migrationsDir });

    await runner.run();

    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
    );
    expect(tables).toHaveLength(1);
    await db.close();
  });

  it("should record version 1 in schema_version after migration", async () => {
    const db = createSQLiteDatabase(":memory:");
    const logger = capturingLogger();
    const runner = createMigrationRunner({ db, fs: realFs, logger, migrationsPath: migrationsDir });

    await runner.run();

    const rows = await db.query<{ version: number; applied_at: string }>(
      "SELECT version, applied_at FROM schema_version"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].applied_at).toBeTruthy();
    await db.close();
  });

  it("should skip already-applied migrations on re-run", async () => {
    const db = createSQLiteDatabase(":memory:");
    const logger = capturingLogger();
    const runner = createMigrationRunner({ db, fs: realFs, logger, migrationsPath: migrationsDir });

    await runner.run();
    await runner.run(); // Second run should be a no-op

    const rows = await db.query<{ version: number }>("SELECT version FROM schema_version");
    expect(rows).toHaveLength(1); // Still only one version
    expect(rows[0].version).toBe(1);

    // Should log "up to date" message
    const upToDate = logger.calls.find((c) => c.message.includes("up to date"));
    expect(upToDate).toBeTruthy();
    await db.close();
  });

  it("should allow inserting data after migration", async () => {
    const db = createSQLiteDatabase(":memory:");
    const logger = capturingLogger();
    const runner = createMigrationRunner({ db, fs: realFs, logger, migrationsPath: migrationsDir });
    await runner.run();

    await db.execute(
      `INSERT INTO memories (id, text, category, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["test-mem-1", "User likes TypeScript", "preference", 0.9, "2026-01-01", "2026-01-01"]
    );

    const rows = await db.query<{ text: string }>("SELECT text FROM memories WHERE id = ?", ["test-mem-1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("User likes TypeScript");
    await db.close();
  });
});
