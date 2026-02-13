/**
 * @fileoverview File encryption service. Encrypts and decrypts file contents using
 * the master key, with optional scope-based path filtering.
 * @module security/encryption
 */

import type { CryptoProvider, EncryptedPayload, FileSystem } from "../core/types.js";

/** @brief Dependencies for createEncryptionService */
export interface EncryptionServiceDeps {
  fs: FileSystem;
  crypto: CryptoProvider;
  masterKey: Uint8Array;
  scope: string[];
}

/** @brief Return type of createEncryptionService */
export interface EncryptionService {
  writeEncrypted(path: string, content: string): Promise<void>;
  readDecrypted(path: string): Promise<string>;
  isInScope(relativePath: string): boolean;
}

/**
 * @brief Creates an encryption service for scoped file encryption/decryption.
 * @param deps - Dependencies: fs, crypto, masterKey, scope
 * @returns Object with writeEncrypted, readDecrypted, and isInScope methods
 */
export function createEncryptionService(deps: EncryptionServiceDeps): EncryptionService {
  const { fs, crypto, masterKey, scope } = deps;

  return {
    /**
     * @brief Encrypts content with crypto.encrypt and stores encrypted payload as JSON.
     * @param path - File path to write
     * @param content - Plaintext content to encrypt and store
     */
    async writeEncrypted(path: string, content: string): Promise<void> {
      const payload = await crypto.encrypt(content, masterKey);
      const json = JSON.stringify(payload);
      await fs.writeFile(path, json);
    },

    /**
     * @brief Reads file, parses JSON as EncryptedPayload, decrypts and returns plaintext.
     * @param path - File path to read
     * @returns Promise resolving to decrypted content
     */
    async readDecrypted(path: string): Promise<string> {
      const raw = await fs.readFile(path);
      const payload: EncryptedPayload = JSON.parse(raw);
      return crypto.decrypt(payload, masterKey);
    },

    /**
     * @brief Checks if any scope pattern matches (startsWith or exact match).
     * @param relativePath - Path to check against scope patterns
     * @returns True if path is in scope
     */
    isInScope(relativePath: string): boolean {
      return scope.some((pattern) => {
        if (pattern.endsWith("/") || pattern.endsWith("*")) {
          const prefix = pattern.replace(/\/?\*?$/, "");
          return relativePath === prefix || relativePath.startsWith(prefix + "/");
        }
        return relativePath === pattern || relativePath.startsWith(pattern + "/");
      });
    },
  };
}
