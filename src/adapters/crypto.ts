/**
 * @fileoverview Real cryptographic provider wrapping node:crypto.
 * @module adapters/crypto
 *
 * @note Uses AES-256-GCM for encryption, scrypt for key derivation,
 * and SHA-256 for hashing. All operations use standard Node.js crypto APIs
 * available in the Bun runtime.
 */

import * as nodeCrypto from "node:crypto";
import type { CryptoProvider, EncryptedPayload } from "../core/types.js";

/**
 * @brief Creates a real crypto provider backed by node:crypto.
 * @returns CryptoProvider implementation using AES-256-GCM, scrypt, SHA-256
 *
 * @example
 * const crypto = createRealCryptoProvider();
 * const key = crypto.randomBytes(32);
 * const encrypted = await crypto.encrypt("secret", key);
 * const decrypted = await crypto.decrypt(encrypted, key);
 */
export function createRealCryptoProvider(): CryptoProvider {
  return {
    /**
     * @brief Generates a random UUID v4.
     * @returns UUID string
     */
    randomUUID(): string {
      return nodeCrypto.randomUUID();
    },

    /**
     * @brief Generates cryptographically random bytes.
     * @param size - Number of bytes to generate
     * @returns Uint8Array of random bytes
     */
    randomBytes(size: number): Uint8Array {
      return new Uint8Array(nodeCrypto.randomBytes(size));
    },

    /**
     * @brief Compares two buffers in constant time to prevent timing attacks.
     * @param a - First buffer
     * @param b - Second buffer
     * @returns true if buffers are equal
     */
    timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
      if (a.length !== b.length) return false;
      return nodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    },

    /**
     * @brief Encrypts a string using AES-256-GCM with a random IV.
     * @param data - Plaintext string to encrypt
     * @param key - 32-byte encryption key
     * @returns EncryptedPayload with base64-encoded iv, data, and auth tag
     */
    async encrypt(data: string, key: Uint8Array): Promise<EncryptedPayload> {
      const iv = nodeCrypto.randomBytes(12);
      const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(data, "utf-8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      return {
        iv: iv.toString("base64"),
        data: encrypted.toString("base64"),
        tag: tag.toString("base64"),
      };
    },

    /**
     * @brief Decrypts an AES-256-GCM encrypted payload.
     * @param payload - EncryptedPayload with base64-encoded iv, data, and tag
     * @param key - 32-byte encryption key (must match the key used for encryption)
     * @returns Decrypted plaintext string
     * @throws If decryption fails (wrong key, tampered data, etc.)
     */
    async decrypt(payload: EncryptedPayload, key: Uint8Array): Promise<string> {
      const iv = Buffer.from(payload.iv, "base64");
      const encrypted = Buffer.from(payload.data, "base64");
      const tag = Buffer.from(payload.tag, "base64");

      const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);

      return decrypted.toString("utf-8");
    },

    /**
     * @brief Derives a 32-byte key from a passphrase using scrypt.
     * @param passphrase - Human-readable passphrase
     * @param salt - 16+ byte salt for key derivation
     * @returns 32-byte derived key
     */
    async deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
      return new Promise((resolve, reject) => {
        nodeCrypto.scrypt(passphrase, Buffer.from(salt), 32, (err, derivedKey) => {
          if (err) reject(err);
          else resolve(new Uint8Array(derivedKey));
        });
      });
    },

    /**
     * @brief Computes a SHA-256 hex digest of the input string.
     * @param data - Input string to hash
     * @returns Hex-encoded SHA-256 hash
     */
    hash(data: string): string {
      return nodeCrypto.createHash("sha256").update(data, "utf-8").digest("hex");
    },
  };
}
