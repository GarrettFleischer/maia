/**
 * @fileoverview Barrel export for all production adapter implementations.
 * @module adapters
 *
 * @note These adapters wrap real runtime APIs (node:fs, bun:sqlite, node:crypto,
 * global fetch, Date, process.env) and implement the DI interfaces from core/types.
 */

export { createRealFileSystem } from "./filesystem.js";
export { createSQLiteDatabase } from "./database.js";
export { createRealCryptoProvider } from "./crypto.js";
export { createRealHttpClient } from "./http-client.js";
export { createRealClock } from "./clock.js";
export { createRealEnvProvider } from "./env.js";
