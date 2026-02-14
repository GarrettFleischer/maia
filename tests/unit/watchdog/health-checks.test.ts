/**
 * @fileoverview Unit tests for watchdog health checks (config, database).
 * @module tests/unit/watchdog/health-checks
 */

import { describe, it, expect } from "bun:test";
import { createConfigHealthCheck } from "../../../src/watchdog/health-checks/config.js";
import { createDatabaseHealthCheck } from "../../../src/watchdog/health-checks/database.js";
import { capturingLogger, testConfig, inMemoryDatabase } from "../../helpers/index.js";
import * as path from "node:path";
import * as fsNative from "node:fs/promises";
import { createSQLiteDatabase } from "../../../src/adapters/database.js";

describe("ConfigHealthCheck", () => {
  it("should return healthy when config is valid", async () => {
    const base = testConfig();
    const config = testConfig({
      gateway: { ...base.gateway, auth: { token: "a-16-char-token!!" }, host: "127.0.0.1" },
    });
    const logger = capturingLogger();
    const check = createConfigHealthCheck({ config, logger });
    const result = await check();
    expect(result.name).toBe("config");
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("valid");
  });

  it("should return unhealthy when auth token is too short", async () => {
    const base = testConfig();
    const config = testConfig({ gateway: { ...base.gateway, auth: { token: "short" } } });
    const logger = capturingLogger();
    const check = createConfigHealthCheck({ config, logger });
    const result = await check();
    expect(result.healthy).toBe(false);
    expect(result.details?.warnings).toBeDefined();
    expect((result.details?.warnings as string[]).some((w) => w.includes("token"))).toBe(true);
  });

  it("should warn when gateway host is 0.0.0.0", async () => {
    const base = testConfig();
    const config = testConfig({
      gateway: { ...base.gateway, auth: { token: "a-16-char-token!!" }, host: "0.0.0.0" },
    });
    const logger = capturingLogger();
    const check = createConfigHealthCheck({ config, logger });
    const result = await check();
    expect(result.healthy).toBe(false);
    expect((result.details?.warnings as string[]).some((w) => w.includes("0.0.0.0"))).toBe(true);
  });
});

describe("DatabaseHealthCheck", () => {
  it("should return healthy when database is accessible", async () => {
    const db = createSQLiteDatabase(":memory:");
    const sqlPath = path.resolve("src/core/migrations/migrations/001_initial_schema.sql");
    const sql = await fsNative.readFile(sqlPath, "utf-8");
    await db.execute(sql);
    const logger = capturingLogger();
    const check = createDatabaseHealthCheck({ db, logger });
    const result = await check();
    expect(result.name).toBe("database");
    expect(result.healthy).toBe(true);
    expect(result.message).toContain("accessible");
    expect(result.details?.memoryCount).toBeDefined();
    await db.close();
  });

  it("should return unhealthy when query throws", async () => {
    const db = inMemoryDatabase();
    const throwingDb = {
      ...db,
      query: async () => {
        throw new Error("DB connection lost");
      },
    };
    const logger = capturingLogger();
    const check = createDatabaseHealthCheck({ db: throwingDb, logger });
    const result = await check();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain("error");
  });
});
