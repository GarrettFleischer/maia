/**
 * @fileoverview Integration test for CredentialStore with real AES-256-GCM crypto.
 * @module tests/integration/credential-store
 *
 * @note Uses real CryptoProvider + inMemoryFileSystem to prove that
 * encrypt/decrypt roundtrip works in the credential store end-to-end.
 * The unit tests only use the base64 mock crypto -- this test proves
 * real AES-256-GCM encryption works with the vault logic.
 */

import { describe, it, expect } from "bun:test";
import { createCredentialStore } from "../../src/security/credential-store.js";
import { createRealCryptoProvider } from "../../src/adapters/crypto.js";
import { inMemoryFileSystem, mockAuditLog, capturingLogger } from "../helpers/index.js";

describe("CredentialStore with real crypto (integration)", () => {
  /**
   * @brief Helper to create a credential store with real encryption.
   */
  function setup() {
    const crypto = createRealCryptoProvider();
    const fs = inMemoryFileSystem();
    const auditLog = mockAuditLog();
    const logger = capturingLogger();
    const masterKey = crypto.randomBytes(32);
    const vaultPath = "/vault/credentials.enc";

    const store = createCredentialStore({
      fs,
      crypto,
      auditLog,
      logger,
      vaultPath,
      masterKey,
    });

    return { store, fs, auditLog, logger, masterKey, vaultPath };
  }

  // ── Basic roundtrip ──────────────────────────────────────────────

  it("should set and get a credential with real encryption", async () => {
    const { store } = setup();
    await store.set("api-key", "sk-1234567890abcdef");
    const cred = await store.get("api-key");
    expect(cred.value).toBe("sk-1234567890abcdef");
    expect(cred.addedAt).toBeTruthy();
  });

  it("should store multiple credentials and retrieve each", async () => {
    const { store } = setup();
    await store.set("groq-key", "gsk_abc");
    await store.set("gemini-key", "AIza_xyz");
    await store.set("openrouter-key", "or_123");

    const groq = await store.get("groq-key");
    expect(groq.value).toBe("gsk_abc");

    const gemini = await store.get("gemini-key");
    expect(gemini.value).toBe("AIza_xyz");

    const openrouter = await store.get("openrouter-key");
    expect(openrouter.value).toBe("or_123");
  });

  // ── Vault is actually encrypted on disk ──────────────────────────

  it("should store encrypted data that is not readable as plaintext", async () => {
    const { store, fs, vaultPath } = setup();
    await store.set("secret", "my-very-secret-value");

    const raw = await fs.readFile(vaultPath);
    // The raw vault file should NOT contain the plaintext value
    expect(raw).not.toContain("my-very-secret-value");
    // It should be valid JSON (encrypted payload)
    const parsed = JSON.parse(raw);
    expect(parsed.iv).toBeTruthy();
    expect(parsed.data).toBeTruthy();
    expect(parsed.tag).toBeTruthy();
  });

  // ── list returns names without values ────────────────────────────

  it("should list credential names without exposing values", async () => {
    const { store } = setup();
    await store.set("key-a", "value-a");
    await store.set("key-b", "value-b");

    const list = await store.list();
    expect(list).toHaveLength(2);
    const names = list.map((c) => c.name).sort();
    expect(names).toEqual(["key-a", "key-b"]);
    // Values should not be in the list
    for (const item of list) {
      expect(item).not.toHaveProperty("value");
    }
  });

  // ── remove then get throws ───────────────────────────────────────

  it("should throw after removing a credential", async () => {
    const { store } = setup();
    await store.set("temp-key", "temp-value");
    await store.remove("temp-key");
    await expect(store.get("temp-key")).rejects.toThrow("Credential not found");
  });

  // ── has checks ───────────────────────────────────────────────────

  it("should report has() correctly", async () => {
    const { store } = setup();
    expect(await store.has("missing")).toBe(false);
    await store.set("exists", "val");
    expect(await store.has("exists")).toBe(true);
    await store.remove("exists");
    expect(await store.has("exists")).toBe(false);
  });

  // ── Audit logging ────────────────────────────────────────────────

  it("should log CREDENTIAL_ADD and CREDENTIAL_ACCESS events", async () => {
    const { store, auditLog } = setup();
    await store.set("audited-key", "audited-val");
    await store.get("audited-key");

    const addEvents = auditLog.entries.filter((e) => e.type === "CREDENTIAL_ADD");
    const accessEvents = auditLog.entries.filter((e) => e.type === "CREDENTIAL_ACCESS");
    expect(addEvents.length).toBeGreaterThanOrEqual(1);
    expect(accessEvents.length).toBeGreaterThanOrEqual(1);
  });

  // ── Overwriting a credential ─────────────────────────────────────

  it("should overwrite a credential and return the new value", async () => {
    const { store } = setup();
    await store.set("mutable", "original");
    await store.set("mutable", "updated");
    const cred = await store.get("mutable");
    expect(cred.value).toBe("updated");
  });
});
