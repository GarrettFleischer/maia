/**
 * @fileoverview Encrypted credential vault store. Persists credentials as encrypted
 * JSON, logs all access to the audit log, and exposes an LLM-opaque interface.
 * @module security/credential-store
 */

import type {
  CredentialStore,
  CryptoProvider,
  EncryptedPayload,
  FileSystem,
  AuditLog,
  Logger,
  StoredCredential,
} from "../core/types.js";

/** @brief Dependencies for createCredentialStore */
export interface CredentialStoreDeps {
  fs: FileSystem;
  crypto: CryptoProvider;
  auditLog: AuditLog;
  logger: Logger;
  vaultPath: string;
  masterKey: Uint8Array;
}

/** @brief Internal vault structure when decrypted */
interface VaultData {
  version: number;
  credentials: Record<string, StoredCredential>;
}

const VAULT_VERSION = 1;

/**
 * @brief Creates a credential store that persists credentials in an encrypted vault.
 * @param deps - Dependencies: fs, crypto, auditLog, logger, vaultPath, masterKey
 * @returns Object implementing the CredentialStore interface
 */
export function createCredentialStore(deps: CredentialStoreDeps): CredentialStore {
  const { fs, crypto, auditLog, logger, vaultPath, masterKey } = deps;

  async function loadVault(): Promise<VaultData> {
    const exists = await fs.exists(vaultPath);
    if (!exists) {
      return { version: VAULT_VERSION, credentials: {} };
    }
    const raw = await fs.readFile(vaultPath);
    const payload: EncryptedPayload = JSON.parse(raw);
    const decrypted = await crypto.decrypt(payload, masterKey);
    return JSON.parse(decrypted) as VaultData;
  }

  async function saveVault(vault: VaultData): Promise<void> {
    const json = JSON.stringify(vault);
    const payload = await crypto.encrypt(json, masterKey);
    await fs.writeFile(vaultPath, JSON.stringify(payload));
  }

  return {
    /**
     * @brief Decrypts vault, finds credential, logs CREDENTIAL_ACCESS, returns value and addedAt.
     * @param name - Credential name to retrieve
     * @returns Promise resolving to { value, addedAt }
     */
    async get(name: string): Promise<StoredCredential> {
      const vault = await loadVault();
      const cred = vault.credentials[name];
      if (!cred) {
        throw new Error(`Credential not found: ${name}`);
      }
      await auditLog.log("CREDENTIAL_ACCESS", { name });
      logger.debug("Credential accessed", { name });
      return cred;
    },

    /**
     * @brief Loads vault (or creates empty), adds credential, encrypts and saves, logs CREDENTIAL_ADD.
     * @param name - Credential name
     * @param value - Credential value to store
     */
    async set(name: string, value: string): Promise<void> {
      const vault = await loadVault();
      const addedAt = new Date().toISOString();
      vault.credentials[name] = { value, addedAt };
      await saveVault(vault);
      await auditLog.log("CREDENTIAL_ADD", { name });
      logger.debug("Credential added", { name });
    },

    /**
     * @brief Loads vault, deletes credential, saves, logs CREDENTIAL_REMOVE.
     * @param name - Credential name to remove
     */
    async remove(name: string): Promise<void> {
      const vault = await loadVault();
      if (!(name in vault.credentials)) {
        return;
      }
      delete vault.credentials[name];
      await saveVault(vault);
      await auditLog.log("CREDENTIAL_REMOVE", { name });
      logger.debug("Credential removed", { name });
    },

    /**
     * @brief Returns array of { name, addedAt } (no values).
     * @returns Promise resolving to list of credential metadata
     */
    async list(): Promise<Array<{ name: string; addedAt: string }>> {
      const vault = await loadVault();
      return Object.entries(vault.credentials).map(([name, cred]) => ({
        name,
        addedAt: cred.addedAt,
      }));
    },

    /**
     * @brief Checks if credential exists.
     * @param name - Credential name to check
     * @returns Promise resolving to boolean
     */
    async has(name: string): Promise<boolean> {
      const vault = await loadVault();
      return name in vault.credentials;
    },
  };
}
