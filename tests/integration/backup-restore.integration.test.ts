/**
 * @fileoverview Integration tests for backup export and restore (full cycle and error paths).
 * @module tests/integration/backup-restore
 *
 * @note Uses real export then restore with mock crypto so decrypt matches encrypt.
 * Covers: full restore, partial restore, corrupt JSON, decryption failure, invalid manifest.
 */

import { describe, it, expect } from "bun:test";
import { createBackupExporter } from "../../src/backup/export.js";
import { createBackupRestorer } from "../../src/backup/restore.js";
import { inMemoryFileSystem, mockCryptoProvider, capturingLogger } from "../helpers/index.js";

const masterKey = new Uint8Array(32).fill(0xbb);

describe("Backup export and restore (integration)", () => {
  it("should restore all files after export", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/SOUL.md": "# Soul",
      "/workspace/USER.md": "# User",
      "/data/maia.db": "db-content",
    });
    const crypto = mockCryptoProvider();
    const logger = capturingLogger();

    const exporter = createBackupExporter({
      fs,
      crypto,
      logger,
      workspacePath: "/workspace",
      dataPath: "/data",
      credentialsPath: "/credentials",
      masterKey,
    });
    await exporter.export("/backup.enc");
    const backupContent = await fs.readFile("/backup.enc");

    const restoreFs = inMemoryFileSystem();
    await restoreFs.writeFile("/backup.enc", backupContent);
    const restorer = createBackupRestorer({
      fs: restoreFs,
      crypto,
      logger,
      workspacePath: "/workspace",
      dataPath: "/data",
      credentialsPath: "/credentials",
      masterKey,
    });

    await restorer.restore("/backup.enc");

    expect(await restoreFs.exists("/workspace/SOUL.md")).toBe(true);
    expect(await restoreFs.readFile("/workspace/SOUL.md")).toBe("# Soul");
    expect(await restoreFs.readFile("/workspace/USER.md")).toBe("# User");
    expect(await restoreFs.readFile("/data/maia.db")).toBe("db-content");
  });

  it("should support partial restore with options.only", async () => {
    const fs = inMemoryFileSystem({
      "/workspace/A.md": "A",
      "/workspace/B.md": "B",
    });
    const crypto = mockCryptoProvider();
    const logger = capturingLogger();

    const exporter = createBackupExporter({
      fs,
      crypto,
      logger,
      workspacePath: "/workspace",
      dataPath: "/data",
      credentialsPath: "/credentials",
      masterKey,
    });
    await exporter.export("/backup.enc");
    const backupContent = await fs.readFile("/backup.enc");

    const restoreFs = inMemoryFileSystem();
    await restoreFs.writeFile("/backup.enc", backupContent);
    const restorer = createBackupRestorer({
      fs: restoreFs,
      crypto,
      logger,
      workspacePath: "/workspace",
      dataPath: "/data",
      credentialsPath: "/credentials",
      masterKey,
    });

    await restorer.restore("/backup.enc", { only: ["/workspace/A.md"] });

    expect(await restoreFs.readFile("/workspace/A.md")).toBe("A");
    expect(await restoreFs.exists("/workspace/B.md")).toBe(false);
  });

  it("should throw when backup file not found", async () => {
    const fs = inMemoryFileSystem();
    const restorer = createBackupRestorer({
      fs,
      crypto: mockCryptoProvider(),
      logger: capturingLogger(),
      workspacePath: "/w",
      dataPath: "/d",
      credentialsPath: "/c",
      masterKey,
    });
    await expect(restorer.restore("/nonexistent.enc")).rejects.toThrow("not found");
  });

  it("should throw on corrupted backup: invalid JSON", async () => {
    const fs = inMemoryFileSystem({ "/bad.enc": "not valid json {{{" });
    const restorer = createBackupRestorer({
      fs,
      crypto: mockCryptoProvider(),
      logger: capturingLogger(),
      workspacePath: "/w",
      dataPath: "/d",
      credentialsPath: "/c",
      masterKey,
    });
    await expect(restorer.restore("/bad.enc")).rejects.toThrow("invalid JSON");
  });

  it("should throw on corrupted backup: decryption failed", async () => {
    const fs = inMemoryFileSystem({
      "/bad.enc": JSON.stringify({ iv: "x", data: "y", tag: "z" }),
    });
    const crypto = mockCryptoProvider();
    const throwingCrypto = {
      ...crypto,
      decrypt: () => Promise.reject(new Error("decryption failed")),
    };
    const restorer = createBackupRestorer({
      fs,
      crypto: throwingCrypto,
      logger: capturingLogger(),
      workspacePath: "/w",
      dataPath: "/d",
      credentialsPath: "/c",
      masterKey,
    });
    await expect(restorer.restore("/bad.enc")).rejects.toThrow("decryption failed");
  });

  it("should throw on invalid manifest JSON after decrypt", async () => {
    const crypto = mockCryptoProvider();
    const plaintext = "not valid json";
    const encrypted = await crypto.encrypt(plaintext, masterKey);
    const fs = inMemoryFileSystem({
      "/bad.enc": JSON.stringify(encrypted),
    });
    const restorer = createBackupRestorer({
      fs,
      crypto,
      logger: capturingLogger(),
      workspacePath: "/w",
      dataPath: "/d",
      credentialsPath: "/c",
      masterKey,
    });
    await expect(restorer.restore("/bad.enc")).rejects.toThrow("invalid manifest");
  });

  it("should throw when manifest version is missing", async () => {
    const crypto = mockCryptoProvider();
    const plaintext = JSON.stringify({ files: { "/a": "b" } });
    const encrypted = await crypto.encrypt(plaintext, masterKey);
    const fs = inMemoryFileSystem({
      "/bad.enc": JSON.stringify(encrypted),
    });
    const restorer = createBackupRestorer({
      fs,
      crypto,
      logger: capturingLogger(),
      workspacePath: "/w",
      dataPath: "/d",
      credentialsPath: "/c",
      masterKey,
    });
    await expect(restorer.restore("/bad.enc")).rejects.toThrow("version");
  });

  it("should throw when requested file not in backup", async () => {
    const crypto = mockCryptoProvider();
    const plaintext = JSON.stringify({ version: 1, files: { "/workspace/A.md": "A" } });
    const encrypted = await crypto.encrypt(plaintext, masterKey);
    const fs = inMemoryFileSystem({
      "/backup.enc": JSON.stringify(encrypted),
    });
    const restorer = createBackupRestorer({
      fs,
      crypto,
      logger: capturingLogger(),
      workspacePath: "/w",
      dataPath: "/d",
      credentialsPath: "/c",
      masterKey,
    });
    await expect(
      restorer.restore("/backup.enc", { only: ["/workspace/missing.md"] })
    ).rejects.toThrow("does not contain");
  });
});
