/**
 * @fileoverview Sandboxed hybrid filesystem for the Maia bash-like shell.
 * Normalizes logical shell paths (~, ~/.., ~/../..) into host paths, enforces
 * a sandbox root, and routes I/O between real and virtual layers.
 * @module lib/shell/fs
 */

import nodePath from "path";
import type { FileSystemAdapter } from "@/lib/context";

export interface FsRoots {
  /**
   * Absolute host path that defines the outermost sandbox boundary.
   * All resolved host paths must remain under this root.
   */
  sandboxRoot: string;

  /**
   * Absolute host path mapped to the shell's tilde (~) directory.
   * This is the agent's workspace directory.
   */
  workspaceRoot: string;

  /**
   * Absolute host path mapped to the logical parent of ~ (~/..),
   * representing the agent's identity directory.
   */
  identityRoot: string;

  /**
   * Absolute host path mapped to the logical parent of the identity
   * directory (~/../..), representing the system of all agents.
   */
  systemRoot: string;
}

/**
 * @brief Policy hook that decides which logical paths map to the real
 * filesystem and which live purely in the virtual layer.
 * @note isReadOnly can be used later by built-ins to reject writes to
 * selected subtrees (for example, global system metadata).
 */
export interface FsPolicy {
  /**
   * @brief Determine whether a logical path should be backed by the real
   * filesystem.
   * @param logicalPath Logical shell path (e.g. "~/.virtual/file.txt").
   * @returns true if the path maps to real disk; false if it is virtual only.
   */
  isRealPath(logicalPath: string): boolean;

  /**
   * @brief Determine whether a logical path is read-only.
   * @param logicalPath Logical shell path.
   * @returns true when write operations must be rejected.
   */
  isReadOnly(logicalPath: string): boolean;
}

/**
 * @brief Sandboxed filesystem that combines:
 * - A real disk adapter (FileSystemAdapter) restricted to sandboxRoot.
 * - An in-memory virtual layer keyed by normalized logical paths.
 * @note This abstraction is synchronous to match FileSystemAdapter and is
 * intended to be wrapped by the asynchronous shell execution engine.
 */
export class HybridFileSystem {
  private readonly roots: FsRoots;
  private readonly realFs: FileSystemAdapter;
  private readonly policy: FsPolicy;
  private readonly virtualFiles = new Map<string, string>();

  constructor(roots: FsRoots, realFs: FileSystemAdapter, policy: FsPolicy) {
    this.roots = roots;
    this.realFs = realFs;
    this.policy = policy;
  }

  /**
   * @brief Resolve a logical shell path into a host filesystem path, clamped
   * to the sandbox root.
   * @param logicalPath Shell-style path (e.g. "~", "~/..", "~/../..", "~/notes.txt").
   * @returns Absolute host path under sandboxRoot.
   * @example
   * const host = fs.resolveHostPath("~");
   */
  resolveHostPath(logicalPath: string): string {
    const normalizedLogical = this.normalizeLogicalPath(logicalPath);

    if (normalizedLogical === "~") return this.roots.workspaceRoot;
    if (normalizedLogical === "~/..") return this.roots.identityRoot;
    if (normalizedLogical === "~/../..") return this.roots.systemRoot;

    const withoutTilde = normalizedLogical.startsWith("~/")
      ? normalizedLogical.slice(2)
      : normalizedLogical;

    const base = this.roots.workspaceRoot;
    const resolved = nodePath.resolve(base, withoutTilde);

    const sandbox = this.normalizeDir(this.roots.sandboxRoot);
    const candidate = this.normalizeDir(resolved);

    if (!candidate.startsWith(sandbox)) {
      return this.roots.sandboxRoot;
    }
    return resolved;
  }

  /**
   * @brief Read file content from either the virtual layer or the real
   * filesystem, depending on FsPolicy.
   * @param logicalPath Logical shell path to read.
   * @returns File contents as UTF-8 text.
   */
  readFile(logicalPath: string): string {
    const key = this.normalizeLogicalPath(logicalPath);
    if (!this.policy.isRealPath(key)) {
      const value = this.virtualFiles.get(key);
      if (value === undefined) {
        throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
      }
      return value;
    }
    const hostPath = this.resolveHostPath(key);
    return this.realFs.readFile(hostPath);
  }

  /**
   * @brief Write content to either the virtual layer or the real filesystem.
   * @param logicalPath Logical shell path to write.
   * @param content File contents as UTF-8 text.
   */
  writeFile(logicalPath: string, content: string): void {
    const key = this.normalizeLogicalPath(logicalPath);
    if (this.policy.isReadOnly(key)) {
      throw new Error(`EACCES: read-only path ${key}`);
    }
    if (!this.policy.isRealPath(key)) {
      this.virtualFiles.set(key, content);
      return;
    }
    const hostPath = this.resolveHostPath(key);
    this.realFs.writeFile(hostPath, content);
  }

  /**
   * @brief Return unique direct children under the given logical directory,
   * merging entries from both real and virtual layers.
   * @param logicalDir Logical directory path (e.g. "~", "~/tmp").
   * @returns Array of entry names (files and subdirectories).
   */
  listDir(logicalDir: string): string[] {
    const dirKey = this.normalizeLogicalPath(logicalDir);
    const entries = new Set<string>();

    // Real filesystem entries
    if (this.policy.isRealPath(dirKey)) {
      const hostDir = this.resolveHostPath(dirKey);
      if (this.realFs.exists(hostDir)) {
        for (const name of this.realFs.listDir(hostDir)) {
          entries.add(name);
        }
      }
    }

    // Virtual entries
    const prefix = dirKey === "~" ? "~/" : `${dirKey.replace(/\/$/, "")}/`;
    for (const key of this.virtualFiles.keys()) {
      if (key.startsWith(prefix)) {
        const remainder = key.slice(prefix.length);
        const name = remainder.split("/")[0];
        if (name.length > 0) {
          entries.add(name);
        }
      }
    }

    return Array.from(entries).sort();
  }

  /**
   * @brief Normalize a logical shell path into a canonical form suitable
   * for use as a key in the virtual layer.
   * @param logicalPath Raw logical path from the shell.
   * @returns Canonical logical path (e.g. "~", "~/file.txt", "~/.virtual/x").
   */
  private normalizeLogicalPath(logicalPath: string): string {
    const trimmed = logicalPath.trim();
    if (trimmed === "" || trimmed === "." || trimmed === "~") return "~";
    if (trimmed === "~/.." || trimmed === "../") return "~/..";
    if (trimmed === "~/../.." || trimmed === "../../") return "~/../..";
    if (trimmed.startsWith("~")) return trimmed;
    // Treat bare relative paths as rooted at ~ for now.
    if (trimmed.startsWith("/")) {
      return `~${trimmed}`;
    }
    return `~/${trimmed}`;
  }

  /**
   * @brief Normalize a host directory path by ensuring it ends with the
   * platform separator and removing redundant segments.
   * @param dirPath Directory path.
   * @returns Normalized directory string with trailing separator.
   */
  private normalizeDir(dirPath: string): string {
    const normalized = nodePath.normalize(dirPath);
    return normalized.endsWith(nodePath.sep)
      ? normalized
      : normalized + nodePath.sep;
  }
}

