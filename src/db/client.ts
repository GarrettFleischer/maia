/**
 * @fileoverview SQLite client for Maia using sql.js. Initializes schema on first use.
 * @module db/client
 */

import initSqlJs from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema";

let initPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;

function getInit(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!initPromise) {
    initPromise = initSqlJs();
  }
  return initPromise;
}

export type DbClient = {
  exec: (sql: string) => void;
  run: (sql: string, params?: unknown[]) => void;
  get: <T>(sql: string, params?: unknown[]) => T | undefined;
  all: <T>(sql: string, params?: unknown[]) => T[];
  close: () => void;
};

/**
 * Opens or creates the database at dbPath and runs the schema if needed.
 * @param dbPath - File path for the SQLite file, or ":memory:" for in-memory
 */
export async function openDb(dbPath: string): Promise<DbClient> {
  const SQL = await getInit();
  let db: InstanceType<Awaited<ReturnType<typeof initSqlJs>>["Database"]>;
  if (dbPath === ":memory:") {
    db = new SQL.Database();
  } else {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(dbPath)) {
      const buf = fs.readFileSync(dbPath);
      db = new SQL.Database(new Uint8Array(buf));
    } else {
      db = new SQL.Database();
    }
  }
  db.run(SCHEMA_SQL);
  return {
    exec(sql: string) {
      db.run(sql);
    },
    run(sql: string, params?: unknown[]) {
      if (params && params.length > 0) {
        const stmt = db.prepare(sql);
        stmt.bind(params as number[]);
        stmt.step();
        stmt.free();
      } else {
        db.run(sql);
      }
    },
    get<T>(sql: string, params?: unknown[]): T | undefined {
      const stmt = db.prepare(sql);
      if (params && params.length > 0) stmt.bind(params as number[]);
      const row = stmt.step() ? (stmt.getAsObject() as T) : undefined;
      stmt.free();
      return row;
    },
    all<T>(sql: string, params?: unknown[]): T[] {
      const stmt = db.prepare(sql);
      if (params && params.length > 0) stmt.bind(params as number[]);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      stmt.free();
      return rows;
    },
    close() {
      if (dbPath !== ":memory:") {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbPath, buffer);
      }
      db.close();
    },
  };
}
