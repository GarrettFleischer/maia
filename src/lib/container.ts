/**
 * @fileoverview DI container for Maia. Holds services (DB, fs, sandbox root, etc.) for injection.
 * @module lib/container
 */

import { resolveSandboxRoot } from "./sandbox";

export type Container = {
  sandboxRoot: string;
  dbPath: string;
  apiKey: string;
};

/**
 * Creates the default container (reads from env).
 * @brief Use in API routes and server code; tests can create a container with overrides.
 */
export function createContainer(overrides?: Partial<Container>): Container {
  const sandboxRoot = resolveSandboxRoot();
  const dbPath =
    process.env.MAIA_DB_PATH?.trim() ||
    `${sandboxRoot}/maia.sqlite`;
  const apiKey = process.env.MAIA_API_KEY ?? "";
  return {
    sandboxRoot,
    dbPath,
    apiKey,
    ...overrides,
  };
}
