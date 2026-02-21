/**
 * Test helper: create a fully-initialised in-memory SQLite database using
 * bun:sqlite (Bun's native built-in SQLite, no native addon required).
 *
 * Returns a DbAdapter-compatible object so it can be used as AppContext.db.
 */
import { Database } from "bun:sqlite";
import { initSchema } from "@/lib/db";
import type { DbAdapter, DbStatement } from "@/lib/context";

function wrapBunDb(raw: Database): DbAdapter {
  return {
    prepare(sql: string): DbStatement {
      const stmt = raw.prepare(sql);
      return {
        run(...args: unknown[]) {
          const result = (stmt as unknown as { run(...a: unknown[]): { changes: number; lastInsertRowid: number } }).run(...args);
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        get(...args: unknown[]) {
          return (stmt as unknown as { get(...a: unknown[]): unknown }).get(...args) ?? undefined;
        },
        all(...args: unknown[]) {
          return (stmt as unknown as { all(...a: unknown[]): unknown[] }).all(...args);
        },
      };
    },
    exec(sql: string) {
      raw.exec(sql);
    },
    pragma(pragma: string) {
      raw.run(`PRAGMA ${pragma}`);
    },
  };
}

export function makeTestDb(): DbAdapter {
  const raw = new Database(":memory:");
  const db = wrapBunDb(raw);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}
