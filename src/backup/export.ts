/**
 * @fileoverview Backup exporter. Collects workspace, data, and credentials into
 * an encrypted manifest and writes to output path.
 * @module backup/export
 */

import type { CryptoProvider, FileSystem, Logger } from "../core/types.js";

/** @brief Dependencies for createBackupExporter. */
export interface BackupExporterDeps {
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

/** @brief Backup exporter interface. */
export interface BackupExporter {
  export(outputPath: string): Promise<void>;
}

/**
 * @brief Recursively collects all files under a directory into a manifest.
 * @param fs - FileSystem implementation
 * @param basePath - Directory path to scan
 * @param manifest - Object to accumulate path -> content
 */
async function collectFiles(
  fs: FileSystem,
  basePath: string,
  manifest: Record<string, string>
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readDir(basePath);
  } catch {
    return;
  }
  const base = basePath.endsWith("/") ? basePath : basePath + "/";
  for (const entry of entries) {
    const full = base + entry;
    try {
      const content = await fs.readFile(full);
      manifest[full] = content;
    } catch {
      try {
        await fs.readDir(full);
        await collectFiles(fs, full, manifest);
      } catch {
        // skip
      }
    }
  }
}

/**
 * @brief Creates a backup exporter that collects and encrypts workspace data.
 * @param deps - Dependencies: fs, crypto, logger, workspacePath, dataPath, credentialsPath, masterKey
 * @returns BackupExporter with export method
 */
export function createBackupExporter(deps: BackupExporterDeps): BackupExporter {
  const { fs, crypto, logger, workspacePath, dataPath, credentialsPath, masterKey } = deps;

  return {
    /**
     * @brief Collects workspace, data, credentials; encrypts manifest; writes to outputPath.
     * @param outputPath - Path to write encrypted backup file
     */
    async export(outputPath: string): Promise<void> {
      const manifest: Record<string, string> = {};
      await collectFiles(fs, workspacePath, manifest);
      await collectFiles(fs, dataPath, manifest);
      await collectFiles(fs, credentialsPath, manifest);

      const payload: BackupManifest = { version: 1, files: manifest };
      const json = JSON.stringify(payload);
      const encrypted = await crypto.encrypt(json, masterKey);
      const encryptedJson = JSON.stringify(encrypted);
      await fs.writeFile(outputPath, encryptedJson);
      logger.info("Backup exported", { outputPath, fileCount: Object.keys(manifest).length });
    },
  };
}
