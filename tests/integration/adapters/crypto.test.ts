/**
 * @fileoverview Integration tests for the real crypto adapter.
 * @module tests/integration/adapters/crypto
 *
 * @note Uses real node:crypto. Tests actual AES-256-GCM encryption,
 * scrypt key derivation, and cryptographic random generation.
 */

import { describe, it, expect } from "bun:test";
import { createRealCryptoProvider } from "../../../src/adapters/crypto.js";

describe("Real CryptoProvider adapter", () => {
  const crypto = createRealCryptoProvider();

  // ── randomUUID ───────────────────────────────────────────────────

  it("should generate a valid UUID v4", () => {
    const uuid = crypto.randomUUID();
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("should generate unique UUIDs", () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    expect(a).not.toBe(b);
  });

  // ── randomBytes ──────────────────────────────────────────────────

  it("should return the requested number of bytes", () => {
    const bytes = crypto.randomBytes(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });

  it("should return different bytes on each call", () => {
    const a = crypto.randomBytes(16);
    const b = crypto.randomBytes(16);
    // Extremely unlikely to be equal
    const aHex = Buffer.from(a).toString("hex");
    const bHex = Buffer.from(b).toString("hex");
    expect(aHex).not.toBe(bHex);
  });

  // ── timingSafeEqual ──────────────────────────────────────────────

  it("should return true for equal buffers", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(crypto.timingSafeEqual(a, b)).toBe(true);
  });

  it("should return false for different buffers", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(crypto.timingSafeEqual(a, b)).toBe(false);
  });

  it("should return false for different-length buffers", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(crypto.timingSafeEqual(a, b)).toBe(false);
  });

  // ── hash ─────────────────────────────────────────────────────────

  it("should produce deterministic hashes", () => {
    const h1 = crypto.hash("hello world");
    const h2 = crypto.hash("hello world");
    expect(h1).toBe(h2);
  });

  it("should produce different hashes for different input", () => {
    const h1 = crypto.hash("alpha");
    const h2 = crypto.hash("beta");
    expect(h1).not.toBe(h2);
  });

  it("should produce a hex string", () => {
    const h = crypto.hash("test");
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  // ── encrypt / decrypt roundtrip ──────────────────────────────────

  it("should encrypt and decrypt a string roundtrip", async () => {
    const key = crypto.randomBytes(32);
    const plaintext = "This is a secret message!";

    const encrypted = await crypto.encrypt(plaintext, key);
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.data).toBeTruthy();
    expect(encrypted.tag).toBeTruthy();

    // Encrypted data should not contain plaintext
    expect(encrypted.data).not.toContain(plaintext);

    const decrypted = await crypto.decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("should encrypt and decrypt empty string", async () => {
    const key = crypto.randomBytes(32);
    const encrypted = await crypto.encrypt("", key);
    const decrypted = await crypto.decrypt(encrypted, key);
    expect(decrypted).toBe("");
  });

  it("should encrypt and decrypt unicode text", async () => {
    const key = crypto.randomBytes(32);
    const plaintext = "Hello 🌙 Maia! 日本語テスト";
    const encrypted = await crypto.encrypt(plaintext, key);
    const decrypted = await crypto.decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("should produce different ciphertext for same plaintext (random IV)", async () => {
    const key = crypto.randomBytes(32);
    const plaintext = "same message";
    const enc1 = await crypto.encrypt(plaintext, key);
    const enc2 = await crypto.encrypt(plaintext, key);
    // IVs should differ, making ciphertext differ
    expect(enc1.iv).not.toBe(enc2.iv);
  });

  it("should fail to decrypt with wrong key", async () => {
    const key1 = crypto.randomBytes(32);
    const key2 = crypto.randomBytes(32);
    const encrypted = await crypto.encrypt("secret", key1);
    await expect(crypto.decrypt(encrypted, key2)).rejects.toThrow();
  });

  it("should fail to decrypt tampered ciphertext", async () => {
    const key = crypto.randomBytes(32);
    const encrypted = await crypto.encrypt("secret", key);
    // Tamper with the data
    const tampered = { ...encrypted, data: encrypted.data + "AA" };
    await expect(crypto.decrypt(tampered, key)).rejects.toThrow();
  });

  // ── deriveKey ────────────────────────────────────────────────────

  it("should derive a 32-byte key from passphrase", async () => {
    const salt = crypto.randomBytes(16);
    const key = await crypto.deriveKey("my-passphrase", salt);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("should produce same key for same passphrase and salt", async () => {
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const key1 = await crypto.deriveKey("passphrase", salt);
    const key2 = await crypto.deriveKey("passphrase", salt);
    expect(Buffer.from(key1).toString("hex")).toBe(Buffer.from(key2).toString("hex"));
  });

  it("should produce different keys for different passphrases", async () => {
    const salt = crypto.randomBytes(16);
    const key1 = await crypto.deriveKey("passphrase-a", salt);
    const key2 = await crypto.deriveKey("passphrase-b", salt);
    expect(Buffer.from(key1).toString("hex")).not.toBe(Buffer.from(key2).toString("hex"));
  });

  it("should produce different keys for different salts", async () => {
    const salt1 = new Uint8Array(16).fill(0x01);
    const salt2 = new Uint8Array(16).fill(0x02);
    const key1 = await crypto.deriveKey("same-passphrase", salt1);
    const key2 = await crypto.deriveKey("same-passphrase", salt2);
    expect(Buffer.from(key1).toString("hex")).not.toBe(Buffer.from(key2).toString("hex"));
  });
});
