/**
 * @fileoverview Tier 2: MEMORY.md helpers for curated long-term memory.
 * @module memory/curated
 * @brief Read, write, and append sections to the MEMORY.md file.
 */

import type { FileSystem } from "../core/types.js";

/** @brief Dependencies for createCuratedMemory */
export interface CuratedMemoryDeps {
  fs: FileSystem;
  memoryPath: string;
}

/** @brief Curated memory interface */
export interface CuratedMemory {
  /** Returns empty string if file doesn't exist */
  read(): Promise<string>;
  /** Overwrite entire file */
  write(content: string): Promise<void>;
  /** Append to end of file */
  appendSection(section: string): Promise<void>;
}

/**
 * @brief Creates a curated memory instance.
 * @param deps - Dependencies: fs, memoryPath
 * @returns CuratedMemory interface
 */
export function createCuratedMemory(deps: CuratedMemoryDeps): CuratedMemory {
  const { fs, memoryPath } = deps;

  async function ensureDir(): Promise<void> {
    const lastSep = Math.max(memoryPath.lastIndexOf("/"), memoryPath.lastIndexOf("\\"));
    if (lastSep > 0) {
      const dir = memoryPath.slice(0, lastSep);
      try {
        await fs.mkdir(dir);
      } catch {
        /* directory may already exist */
      }
    }
  }

  return {
    async read(): Promise<string> {
      const exists = await fs.exists(memoryPath);
      if (!exists) return "";
      try {
        return await fs.readFile(memoryPath);
      } catch {
        return "";
      }
    },

    async write(content: string): Promise<void> {
      await ensureDir();
      await fs.writeFile(memoryPath, content);
    },

    async appendSection(section: string): Promise<void> {
      const existing = await fs.exists(memoryPath)
        ? await fs.readFile(memoryPath).catch(() => "")
        : "";
      const newContent = existing ? `${existing}\n${section}` : section;
      await ensureDir();
      await fs.writeFile(memoryPath, newContent);
    },
  };
}
