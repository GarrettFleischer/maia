/**
 * @fileoverview Secrets store: CRUD with encrypted values; never expose to LLM.
 * @module db/secrets
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { DbClient } from "./client";

const ALGO = "aes-256-gcm";
const IV_LEN = 16;
const SALT_LEN = 32;
const KEY_LEN = 32;

function deriveKey(secretKey: string, salt: Buffer): Buffer {
  return scryptSync(secretKey, salt, KEY_LEN);
}

function encrypt(plain: string, secretKey: string): string {
  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(secretKey, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, enc]).toString("base64");
}

function decrypt(encoded: string, secretKey: string): string {
  const buf = Buffer.from(encoded, "base64");
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = buf.subarray(
    SALT_LEN + IV_LEN,
    SALT_LEN + IV_LEN + 16
  );
  const enc = buf.subarray(SALT_LEN + IV_LEN + 16);
  const key = deriveKey(secretKey, salt);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}

export function createSecretsRepository(
  db: DbClient,
  encryptionKey: string
) {
  return {
    async set(key: string, value: string): Promise<void> {
      const encrypted = encrypt(value, encryptionKey);
      const now = Date.now();
      db.run(
        "INSERT OR REPLACE INTO secrets (key, value_encrypted, created_at) VALUES (?, ?, ?)",
        [key, encrypted, now]
      );
    },
    async get(key: string): Promise<string | null> {
      const row = db.get<{ value_encrypted: string }>(
        "SELECT value_encrypted FROM secrets WHERE key = ?",
        [key]
      );
      if (!row) return null;
      return decrypt(row.value_encrypted, encryptionKey);
    },
    async listKeys(): Promise<string[]> {
      const rows = db.all<{ key: string }>("SELECT key FROM secrets");
      return rows.map((r) => r.key);
    },
    async delete(key: string): Promise<void> {
      db.run("DELETE FROM secrets WHERE key = ?", [key]);
    },
  };
}
