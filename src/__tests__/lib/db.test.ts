/**
 * @fileoverview Tests for db module: initSchema and table existence via makeTestDb.
 * @module __tests__/lib/db
 */
import { describe, it, expect } from "bun:test";
import { initSchema } from "@/lib/db";
import { makeTestDb } from "@/__tests__/helpers/db";
import type { DbAdapter } from "@/lib/context";

const EXPECTED_TABLES = [
  "active_session",
  "agents",
  "credentials",
  "cron_jobs",
  "history_entries",
  "history_vectors",
  "knowledge_vectors",
  "security_events",
  "sessions",
  "settings",
];

function getTableNames(db: DbAdapter): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("db", () => {
  describe("initSchema", () => {
    it("creates all expected tables when applied via makeTestDb", () => {
      const db = makeTestDb();
      const names = getTableNames(db);
      for (const table of EXPECTED_TABLES) {
        expect(names).toContain(table);
      }
    });

    it("is idempotent (can be run twice without error)", () => {
      const db = makeTestDb();
      initSchema(db);
      const names = getTableNames(db);
      for (const table of EXPECTED_TABLES) {
        expect(names).toContain(table);
      }
    });

    it("seeds active_session singleton row", () => {
      const db = makeTestDb();
      const row = db.prepare(
        "SELECT singleton, session_id FROM active_session"
      ).get() as { singleton: number; session_id: string | null };
      expect(row).toBeDefined();
      expect(row.singleton).toBe(1);
    });

    it("seeds default settings when not present", () => {
      const db = makeTestDb();
      const rows = db.prepare("SELECT key, value FROM settings").all() as {
        key: string;
        value: string;
      }[];
      const keys = rows.map((r) => r.key);
      expect(keys).toContain("whitelistedModels");
      expect(keys).toContain("heartbeatIntervalMinutes");
      expect(keys).toContain("contextQueryModel");
    });

    it("seeds built-in heartbeat cron job row", () => {
      const db = makeTestDb();
      const row = db.prepare(
        "SELECT id, expression, task_description, agent_id, is_built_in FROM cron_jobs WHERE id = 'builtin-heartbeat'"
      ).get() as { id: string; expression: string; task_description: string; agent_id: string; is_built_in: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.id).toBe("builtin-heartbeat");
      expect(row!.is_built_in).toBe(1);
      expect(row!.expression).toBe("*/30 * * * *");
      expect(row!.task_description).toBe("Heartbeat");
      expect(row!.agent_id).toBe("maia");
    });
  });
});
