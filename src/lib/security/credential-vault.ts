import crypto from "crypto";
import { getDb } from "../db";
import type { EncryptedValue } from "../types";

function getMasterKey(): Buffer {
  const keyEnv = process.env.CREDENTIAL_MASTER_KEY;
  if (!keyEnv) {
    // Derive a stable key from a machine-specific value for local dev
    // In production, always set CREDENTIAL_MASTER_KEY
    const fallback = "maia-local-dev-key-do-not-use-in-prod";
    return crypto.createHash("sha256").update(fallback).digest();
  }
  const buf = Buffer.from(keyEnv, "hex");
  if (buf.length !== 32) {
    throw new Error("CREDENTIAL_MASTER_KEY must be a 64-character hex string (32 bytes)");
  }
  return buf;
}

function encrypt(plaintext: string): EncryptedValue {
  const masterKey = getMasterKey();
  const iv = crypto.randomBytes(12); // 96-bit nonce
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(enc: EncryptedValue): string {
  const masterKey = getMasterKey();
  const iv = Buffer.from(enc.iv, "base64");
  const tag = Buffer.from(enc.tag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

// LLM-accessible operations (no value read)
export function credentialCreate(key: string, value: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const enc = encrypt(value);
  db.prepare(
    `INSERT OR REPLACE INTO credentials (key, iv, tag, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(key, enc.iv, enc.tag, enc.ciphertext, now, now);
}

export function credentialUpdate(key: string, value: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const enc = encrypt(value);
  const result = db.prepare(
    `UPDATE credentials SET iv = ?, tag = ?, ciphertext = ?, updated_at = ? WHERE key = ?`
  ).run(enc.iv, enc.tag, enc.ciphertext, now, key);
  if (result.changes === 0) throw new Error(`Credential not found: ${key}`);
}

export function credentialDelete(key: string): void {
  const db = getDb();
  db.prepare("DELETE FROM credentials WHERE key = ?").run(key);
}

export function credentialList(): string[] {
  const db = getDb();
  const rows = db.prepare("SELECT key FROM credentials ORDER BY key").all() as { key: string }[];
  return rows.map((r) => r.key);
}

// Internal-only — NOT exposed to LLM
export function credentialGet(key: string): string {
  const db = getDb();
  const row = db.prepare("SELECT iv, tag, ciphertext FROM credentials WHERE key = ?").get(key) as
    | EncryptedValue
    | undefined;
  if (!row) throw new Error(`Credential not found: ${key}`);
  return decrypt(row);
}
