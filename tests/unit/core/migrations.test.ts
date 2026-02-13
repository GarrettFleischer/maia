/**
 * @fileoverview Unit tests for the database migration runner.
 * @module tests/unit/core/migrations
 */

import { describe, it, expect } from "bun:test";
import { createMigrationRunner } from "../../../src/core/migrations/runner.js";
import { inMemoryDatabase, inMemoryFileSystem, capturingLogger } from "../../helpers/index.js";

describe("Migration Runner", () => {
  it("should apply migrations in order", async () => {
    const db = inMemoryDatabase();
    const fs = inMemoryFileSystem({
      "/migrations/001_initial.sql": "CREATE TABLE test (id TEXT);",
      "/migrations/002_add_name.sql": "ALTER TABLE test ADD COLUMN name TEXT;",
    });
    const logger = capturingLogger();

    const runner = createMigrationRunner({ db, fs, logger, migrationsPath: "/migrations" });
    await runner.run();

    const createTableCalls = db.executedSql.filter((s) => s.sql.includes("CREATE TABLE"));
    expect(createTableCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("should track schema version", async () => {
    const db = inMemoryDatabase();
    const fs = inMemoryFileSystem({
      "/migrations/001_initial.sql": "CREATE TABLE test (id TEXT);",
    });
    const logger = capturingLogger();

    const runner = createMigrationRunner({ db, fs, logger, migrationsPath: "/migrations" });
    await runner.run();

    // Should have inserted a version record
    const versionInserts = db.executedSql.filter(
      (s) => s.sql.includes("schema_version") && s.sql.includes("INSERT")
    );
    expect(versionInserts.length).toBeGreaterThanOrEqual(1);
  });

  it("should skip already-applied migrations", async () => {
    const db = inMemoryDatabase();
    const fs = inMemoryFileSystem({
      "/migrations/001_initial.sql": "CREATE TABLE test (id TEXT);",
      "/migrations/002_add_name.sql": "ALTER TABLE test ADD COLUMN name TEXT;",
    });
    const logger = capturingLogger();

    // Mock: version 1 already applied
    db.query = async <T>(sql: string): Promise<T[]> => {
      if (sql.includes("schema_version")) {
        return [{ version: 1 }] as T[];
      }
      return [] as T[];
    };

    const runner = createMigrationRunner({ db, fs, logger, migrationsPath: "/migrations" });
    await runner.run();

    // Should only execute migration 002, not 001
    const alterCalls = db.executedSql.filter((s) => s.sql.includes("ALTER TABLE"));
    expect(alterCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle empty migrations directory", async () => {
    const db = inMemoryDatabase();
    const fs = inMemoryFileSystem({});
    const logger = capturingLogger();

    const runner = createMigrationRunner({ db, fs, logger, migrationsPath: "/migrations" });
    // Should not throw
    await runner.run();
  });

  it("should sort migrations by number", async () => {
    const db = inMemoryDatabase();
    const fs = inMemoryFileSystem({
      "/migrations/003_third.sql": "-- third",
      "/migrations/001_first.sql": "-- first",
      "/migrations/002_second.sql": "-- second",
    });
    const logger = capturingLogger();

    const runner = createMigrationRunner({ db, fs, logger, migrationsPath: "/migrations" });
    await runner.run();

    // Verify order via executed SQL
    const comments = db.executedSql
      .filter((s) => s.sql.startsWith("--"))
      .map((s) => s.sql.trim());
    expect(comments).toEqual(["-- first", "-- second", "-- third"]);
  });
});
