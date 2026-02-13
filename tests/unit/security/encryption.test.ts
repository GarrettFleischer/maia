/**
 * @fileoverview Unit tests for AES-256-GCM file encryption at rest.
 * @module tests/unit/security/encryption
 */

import { describe, it, expect } from "bun:test";
import { createEncryptionService } from "../../../src/security/encryption.js";
import { inMemoryFileSystem, mockCryptoProvider } from "../../helpers/index.js";

describe("Encryption at Rest", () => {
  function makeService() {
    const fs = inMemoryFileSystem();
    const crypto = mockCryptoProvider();
    const service = createEncryptionService({
      fs,
      crypto,
      masterKey: new Uint8Array(32).fill(0xbb),
      scope: ["USER.md", "MEMORY.md", "memory/"],
    });
    return { service, fs };
  }

  it("should encrypt file content when writing", async () => {
    const { service, fs } = makeService();
    await service.writeEncrypted("/workspace/USER.md", "sensitive content");

    const stored = await fs.readFile("/workspace/USER.md");
    expect(stored).not.toBe("sensitive content");
  });

  it("should decrypt file content when reading", async () => {
    const { service } = makeService();
    await service.writeEncrypted("/workspace/USER.md", "sensitive content");
    const content = await service.readDecrypted("/workspace/USER.md");
    expect(content).toBe("sensitive content");
  });

  it("should check if a path is in scope for encryption", () => {
    const { service } = makeService();
    expect(service.isInScope("USER.md")).toBe(true);
    expect(service.isInScope("MEMORY.md")).toBe(true);
    expect(service.isInScope("memory/2026-02-13.md")).toBe(true);
    expect(service.isInScope("SOUL.md")).toBe(false);
    expect(service.isInScope("AGENTS.md")).toBe(false);
  });

  it("should handle empty content", async () => {
    const { service } = makeService();
    await service.writeEncrypted("/workspace/USER.md", "");
    const content = await service.readDecrypted("/workspace/USER.md");
    expect(content).toBe("");
  });

  it("should handle large content", async () => {
    const { service } = makeService();
    const largeContent = "x".repeat(100000);
    await service.writeEncrypted("/workspace/USER.md", largeContent);
    const content = await service.readDecrypted("/workspace/USER.md");
    expect(content).toBe(largeContent);
  });
});
