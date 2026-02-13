/**
 * @fileoverview File system sandbox. Wraps a FileSystem and restricts all operations
 * to a single root directory; paths outside the root are denied and logged.
 * @module security/sandbox-fs
 *
 * @note When the sandbox is enabled, the sandbox root must contain all paths used
 * by the application (workspace, vault, audit log, data dir, etc.).
 */

import path from "node:path";
import type { FileSystem, FileStat, AuditLog, Logger } from "../core/types.js";
import { SecurityError } from "../core/errors.js";

/** @brief Dependencies for createSandboxedFileSystem */
export interface SandboxedFileSystemDeps {
  /** The underlying FileSystem to delegate to when path is allowed */
  inner: FileSystem;
  /** Absolute or relative root path; all operations must be under this directory */
  root: string;
  /** Audit log for FILE_ACCESS_DENIED events */
  auditLog: AuditLog;
  /** Logger for warning messages */
  logger: Logger;
}

/**
 * @brief Resolves and normalizes a path to a canonical absolute form.
 * @param p - Path string (absolute or relative)
 * @returns Normalized absolute path (POSIX-style on Windows for consistent prefix check)
 */
function resolveAbsolute(p: string): string {
  const resolved = path.resolve(p);
  const normalized = path.normalize(resolved);
  return normalized;
}

/**
 * @brief Returns whether the resolved path is under the sandbox root.
 * @param resolvedPath - Normalized absolute path of the request
 * @param rootPath - Normalized absolute path of the sandbox root
 * @returns true if resolvedPath is rootPath or under it
 */
function isUnderRoot(resolvedPath: string, rootPath: string): boolean {
  if (resolvedPath === rootPath) return true;
  const sep = path.sep;
  const prefix = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
  return resolvedPath.startsWith(prefix);
}

/**
 * @brief Creates a sandboxed FileSystem that denies and logs access outside the root.
 * @param deps - Dependencies: inner FileSystem, root path, auditLog, logger
 * @returns FileSystem implementation that enforces the sandbox boundary
 *
 * @example
 * const fs = createSandboxedFileSystem({
 *   inner: realFs,
 *   root: "/home/user/.maia",
 *   auditLog,
 *   logger,
 * });
 */
export function createSandboxedFileSystem(deps: SandboxedFileSystemDeps): FileSystem {
  const { inner, auditLog, logger } = deps;
  const rootPath = resolveAbsolute(deps.root);

  /**
   * @brief Ensures the path is under the sandbox root; otherwise logs and throws.
   * @param requestPath - Original path from the caller
   * @param operation - Operation name for audit (e.g. "readFile")
   * @returns Resolved path safe to pass to inner
   */
  async function assertUnderRoot(requestPath: string, operation: string): Promise<string> {
    const resolvedPath = resolveAbsolute(requestPath);
    if (!isUnderRoot(resolvedPath, rootPath)) {
      await auditLog.log("FILE_ACCESS_DENIED", {
        path: requestPath,
        resolvedPath,
        operation,
      });
      logger.warn("File access denied: path outside sandbox", {
        path: requestPath,
        resolvedPath,
        operation,
      });
      throw new SecurityError(
        "File access denied: path outside sandbox",
        "high"
      );
    }
    return resolvedPath;
  }

  return {
    async readFile(pathArg: string): Promise<string> {
      await assertUnderRoot(pathArg, "readFile");
      return inner.readFile(pathArg);
    },

    async writeFile(pathArg: string, content: string): Promise<void> {
      await assertUnderRoot(pathArg, "writeFile");
      return inner.writeFile(pathArg, content);
    },

    async appendFile(pathArg: string, content: string): Promise<void> {
      await assertUnderRoot(pathArg, "appendFile");
      return inner.appendFile(pathArg, content);
    },

    async exists(pathArg: string): Promise<boolean> {
      await assertUnderRoot(pathArg, "exists");
      return inner.exists(pathArg);
    },

    async readDir(pathArg: string): Promise<string[]> {
      await assertUnderRoot(pathArg, "readDir");
      return inner.readDir(pathArg);
    },

    async mkdir(pathArg: string): Promise<void> {
      await assertUnderRoot(pathArg, "mkdir");
      return inner.mkdir(pathArg);
    },

    async chmod(pathArg: string, mode: number): Promise<void> {
      await assertUnderRoot(pathArg, "chmod");
      return inner.chmod(pathArg, mode);
    },

    async stat(pathArg: string): Promise<FileStat> {
      await assertUnderRoot(pathArg, "stat");
      return inner.stat(pathArg);
    },

    async checksum(pathArg: string): Promise<string> {
      await assertUnderRoot(pathArg, "checksum");
      return inner.checksum(pathArg);
    },

    async remove(pathArg: string): Promise<void> {
      await assertUnderRoot(pathArg, "remove");
      return inner.remove(pathArg);
    },
  };
}
