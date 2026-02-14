/**
 * @fileoverview Real SQLite database adapter wrapping bun:sqlite.
 * @module adapters/database
 *
 * @note bun:sqlite is synchronous. This adapter wraps calls in resolved
 * promises to match the async Database interface, enabling consistent
 * usage across production and test code.
 */

import { Database as BunSQLite } from "bun:sqlite";
import type { Database } from "../core/types.js";

/**
 * @brief Creates a real SQLite database adapter.
 * @param dbPath - Path to the SQLite database file, or ":memory:" for in-memory
 * @returns Database implementation backed by bun:sqlite
 *
 * @example
 * const db = createSQLiteDatabase("~/.maia/data/maia.db");
 * await db.execute("CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY)");
 */
export function createSQLiteDatabase(dbPath: string): Database {
  const db = new BunSQLite(dbPath);

  // Enable WAL mode for better concurrent performance
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }

  return {
    /**
     * @brief Executes a SQL statement (INSERT, UPDATE, DELETE, CREATE, etc.).
     * @param sql - SQL statement, may contain ? placeholders
     * @param params - Optional parameter values for placeholders
     */
    async execute(sql: string, params?: unknown[]): Promise<void> {
      if (params && params.length > 0) {
        db.run(sql, params as (string | number | null | Uint8Array)[]);
      } else {
        db.exec(sql);
      }
    },

    /**
     * @brief Executes a SQL query and returns rows.
     * @param sql - SQL SELECT statement, may contain ? placeholders
     * @param params - Optional parameter values for placeholders
     * @returns Array of row objects
     */
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const stmt = db.prepare(sql);
      if (params && params.length > 0) {
        return stmt.all(...(params as (string | number | null | Uint8Array)[])) as T[];
      }
      return stmt.all() as T[];
    },

    /**
     * @brief Closes the database connection.
     */
    async close(): Promise<void> {
      db.close();
    },
  };
}
