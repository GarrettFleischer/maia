/**
 * @fileoverview Composition helper for building the application FileSystem.
 * @module core/compose-fs
 *
 * @note When the sandbox is enabled in config, wraps the raw FileSystem with
 * SandboxedFileSystem so all file operations are restricted to the configured root.
 * Config loading uses the raw fs before this wrapper is applied.
 */

import type { FileSystem, MaiaConfig, AuditLog, Logger } from "./types.js";
import { createSandboxedFileSystem } from "../security/sandbox-fs.js";

/**
 * @brief Builds the FileSystem to use for MaiaContext (optionally sandboxed).
 * @param rawFs - The real or test FileSystem implementation
 * @param config - Validated config (must be loaded before calling)
 * @param auditLog - Audit log for FILE_ACCESS_DENIED events when sandbox is enabled
 * @param logger - Logger for sandbox warnings
 * @returns FileSystem to inject into MaiaContext
 *
 * @example
 * const config = await loadConfig(configPath, { fs: rawFs, env, logger });
 * const fs = createApplicationFileSystem(rawFs, config, auditLog, logger);
 * const ctx = { ...baseContext, fs };
 */
export function createApplicationFileSystem(
  rawFs: FileSystem,
  config: MaiaConfig,
  auditLog: AuditLog,
  logger: Logger
): FileSystem {
  const sandbox = config.security.sandbox;
  if (sandbox?.enabled === false) {
    return rawFs;
  }
  const root = sandbox?.root ?? config.workspace.path;
  return createSandboxedFileSystem({
    inner: rawFs,
    root,
    auditLog,
    logger,
  });
}
