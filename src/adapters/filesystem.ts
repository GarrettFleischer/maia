/**
 * @fileoverview Real filesystem adapter wrapping node:fs/promises.
 * @module adapters/filesystem
 *
 * @note This is the production implementation of the FileSystem interface.
 * No module should use node:fs directly -- inject this adapter instead.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { FileSystem, FileStat } from "../core/types.js";

/**
 * @brief Creates a real filesystem adapter backed by node:fs/promises.
 * @returns FileSystem implementation that operates on the real disk
 *
 * @example
 * const fileSystem = createRealFileSystem();
 * await fileSystem.writeFile("/tmp/hello.txt", "world");
 */
export function createRealFileSystem(): FileSystem {
  return {
    /**
     * @brief Reads file content as UTF-8 text.
     * @param filePath - Absolute path to the file
     * @returns File content as string
     * @throws If file does not exist or is not readable
     */
    async readFile(filePath: string): Promise<string> {
      return fs.readFile(filePath, "utf-8");
    },

    /**
     * @brief Writes text content to a file, creating parent directories if needed.
     * @param filePath - Absolute path to the file
     * @param content - Text content to write
     */
    async writeFile(filePath: string, content: string): Promise<void> {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
    },

    /**
     * @brief Appends text content to a file, creating it if it doesn't exist.
     * @param filePath - Absolute path to the file
     * @param content - Text content to append
     */
    async appendFile(filePath: string, content: string): Promise<void> {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(filePath, content, "utf-8");
    },

    /**
     * @brief Checks if a path exists on disk.
     * @param filePath - Absolute path to check
     * @returns true if the path exists
     */
    async exists(filePath: string): Promise<boolean> {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * @brief Lists entries in a directory (file and subdirectory names).
     * @param dirPath - Absolute path to the directory
     * @returns Array of entry names
     * @throws If directory does not exist
     */
    async readDir(dirPath: string): Promise<string[]> {
      return fs.readdir(dirPath);
    },

    /**
     * @brief Creates a directory, including any missing parent directories.
     * @param dirPath - Absolute path to create
     */
    async mkdir(dirPath: string): Promise<void> {
      await fs.mkdir(dirPath, { recursive: true });
    },

    /**
     * @brief Changes file permissions.
     * @param filePath - Absolute path to the file
     * @param mode - Permission mode (e.g. 0o600)
     * @note On Windows this may be a partial no-op.
     */
    async chmod(filePath: string, mode: number): Promise<void> {
      await fs.chmod(filePath, mode);
    },

    /**
     * @brief Returns file or directory metadata.
     * @param filePath - Absolute path
     * @returns FileStat with size, isFile, isDirectory, mtime
     * @throws If path does not exist
     */
    async stat(filePath: string): Promise<FileStat> {
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        mtime: stats.mtime,
      };
    },

    /**
     * @brief Computes a SHA-256 hex digest of the file content.
     * @param filePath - Absolute path to the file
     * @returns Hex-encoded SHA-256 checksum
     * @throws If file does not exist
     */
    async checksum(filePath: string): Promise<string> {
      const content = await fs.readFile(filePath);
      return createHash("sha256").update(content).digest("hex");
    },

    /**
     * @brief Removes a file or directory (recursively).
     * @param filePath - Absolute path to remove
     */
    async remove(filePath: string): Promise<void> {
      await fs.rm(filePath, { recursive: true, force: true });
    },
  };
}
