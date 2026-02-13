/**
 * @fileoverview Backup restorer. Reads encrypted backup, validates integrity,
 * and writes files back to their original locations.
 * @module backup/restore
 */

import type { CryptoProvider, FileSystem, Logger } from "../core/types.js";

/** @brief Dependencies for createBackupRestorer. */
export interface BackupRestorerDeps {
  fs: FileSystem;
  crypto: CryptoProvider;
  logger: Logger;
  workspacePath: string;
  dataPath: string;
  credentialsPath: string;
  masterKey: Uint8Array;
}

/** @brief Backup manifest structure. */
export interface BackupManifest {
  version: number;
  files: Record<string, string>;
}

/** @brief Restore options. */
export interface RestoreOptions {
  only?: string[];
}

/** @brief Backup restorer interface. */
export interface BackupRestorer {
  restore(inputPath: string, options?: RestoreOptions): Promise<void>;
}

/**
 * @brief Creates a backup restorer that decrypts and restores files.
 * @param deps - Dependencies: fs, crypto, logger, paths, masterKey
 * @returns BackupRestorer with restore method
 */
export function createBackupRestorer(deps: BackupRestorerDeps): BackupRestorer {
  const { fs, crypto, logger, masterKey } = deps;

  return {
    /**
     * @brief Reads encrypted backup, validates, and restores files.
     * @param inputPath - Path to encrypted backup file
     * @param options - Optional: only restore specified paths
     * @throws On nonexistent file, corrupted data, or invalid manifest
     */
    async restore(inputPath: string, options?: RestoreOptions): Promise<void> {
      const exists = await fs.exists(inputPath);
      if (!exists) {
        throw new Error(`Backup file not found: ${inputPath}`);
      }

      const raw = await fs.readFile(inputPath);
      let encrypted: { iv: string; data: string; tag: string };
      try {
        encrypted = JSON.parse(raw);
      } catch {
        throw new Error("Corrupted backup: invalid JSON");
      }

      let json: string;
      try {
        json = await crypto.decrypt(encrypted, masterKey);
      } catch {
        throw new Error("Corrupted backup: decryption failed");
      }

      let manifest: BackupManifest;
      try {
        manifest = JSON.parse(json);
      } catch {
        throw new Error("Corrupted backup: invalid manifest JSON");
      }

      if (typeof manifest.version !== "number") {
        throw new Error("Corrupted backup: missing or invalid version field");
      }

      const paths = options?.only ?? Object.keys(manifest.files);
      for (const filePath of paths) {
        const content = manifest.files[filePath];
        if (content === undefined) {
          throw new Error(`Backup does not contain: ${filePath}`);
        }
        const parts = filePath.split("/").filter(Boolean);
        if (parts.length > 1) {
          let current = filePath.startsWith("/") ? "/" : "";
          for (let i = 0; i < parts.length - 1; i++) {
            current = current + (current === "/" ? "" : "/") + parts[i];
            const exists = await fs.exists(current);
            if (!exists) await fs.mkdir(current);
          }
        }
        await fs.writeFile(filePath, content);
      }
      logger.info("Backup restored", { inputPath, fileCount: paths.length });
    },
  };
}
