/**
 * @fileoverview Unit tests for encrypted credential store (LLM-opaque).
 * @module tests/unit/security/credential-store
 */

import { describe, it, expect } from "bun:test";
import { createCredentialStore } from "../../../src/security/credential-store.js";
import { inMemoryFileSystem, mockCryptoProvider, mockAuditLog, capturingLogger } from "../../helpers/index.js";

describe("Credential Store", () => {
  function makeStore() {
    const fs = inMemoryFileSystem();
    const crypto = mockCryptoProvider();
    const auditLog = mockAuditLog();
    const logger = capturingLogger();
    const store = createCredentialStore({
      fs,
      crypto,
      auditLog,
      logger,
      vaultPath: "/credentials/vault.enc",
      masterKey: new Uint8Array(32).fill(0xbb),
    });
    return { store, fs, crypto, auditLog };
  }

  it("should store and retrieve a credential", async () => {
    const { store } = makeStore();
    await store.set("github-token", "ghp_abc123");
    const cred = await store.get("github-token");
    expect(cred.value).toBe("ghp_abc123");
  });

  it("should throw when getting a nonexistent credential", async () => {
    const { store } = makeStore();
    await expect(store.get("nonexistent")).rejects.toThrow();
  });

  it("should list credential names without values", async () => {
    const { store } = makeStore();
    await store.set("api-key-1", "value1");
    await store.set("api-key-2", "value2");

    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.name)).toContain("api-key-1");
    expect(list.map((c) => c.name)).toContain("api-key-2");
    // Should NOT contain values
    for (const item of list) {
      expect(item).not.toHaveProperty("value");
    }
  });

  it("should remove a credential", async () => {
    const { store } = makeStore();
    await store.set("to-remove", "value");
    await store.remove("to-remove");
    const hasIt = await store.has("to-remove");
    expect(hasIt).toBe(false);
  });

  it("should check if credential exists", async () => {
    const { store } = makeStore();
    expect(await store.has("nope")).toBe(false);
    await store.set("yes", "value");
    expect(await store.has("yes")).toBe(true);
  });

  it("should encrypt the vault when writing", async () => {
    const { store, crypto } = makeStore();
    let encryptCalled = false;
    const originalEncrypt = crypto.encrypt;
    crypto.encrypt = async (data, key) => {
      encryptCalled = true;
      return originalEncrypt(data, key);
    };

    await store.set("test", "value");
    expect(encryptCalled).toBe(true);
  });

  it("should log credential access to audit log", async () => {
    const { store, auditLog } = makeStore();
    await store.set("test-key", "test-value");
    await store.get("test-key");

    const accessEvents = auditLog.entries.filter(
      (e) => e.type === "CREDENTIAL_ACCESS"
    );
    expect(accessEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("should log credential addition to audit log", async () => {
    const { store, auditLog } = makeStore();
    await store.set("new-key", "new-value");

    const addEvents = auditLog.entries.filter(
      (e) => e.type === "CREDENTIAL_ADD"
    );
    expect(addEvents.length).toBeGreaterThanOrEqual(1);
    expect(addEvents[0].metadata.name).toBe("new-key");
  });

  it("should overwrite existing credentials", async () => {
    const { store } = makeStore();
    await store.set("key", "old-value");
    await store.set("key", "new-value");
    const cred = await store.get("key");
    expect(cred.value).toBe("new-value");
  });
});
