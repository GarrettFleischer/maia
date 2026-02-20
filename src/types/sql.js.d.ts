/**
 * @fileoverview Type declarations for sql.js (no official @types/sql.js).
 * @module types/sql.js
 */

declare module "sql.js" {
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
  }
  export interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    prepare(sql: string): SqlJsStatement;
    export(): Uint8Array;
    close(): void;
  }
  export interface SqlJsStatement {
    bind(values: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    get(): unknown[];
    free(): void;
  }
  export default function initSqlJs(
    config?: { locateFile?: (file: string) => string }
  ): Promise<SqlJsStatic>;
}
