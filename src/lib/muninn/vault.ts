/**
 * @fileoverview Vault name resolution for MuninnDB (per-agent or default).
 * @module lib/muninn/vault
 *
 * Vault names must be 1-64 chars: lowercase letters, digits, hyphens, underscores only.
 * @see https://muninndb.com/docs/vault-management
 */

const VAULT_NAME_MAX = 64;
const VAULT_NAME_REGEX = /[^a-z0-9_-]/g;

/**
 * Normalizes a string to a valid Muninn vault name (lowercase, alphanumeric, hyphens, underscores).
 * @param name - Raw name (e.g. agent id or "default")
 * @returns Valid vault name, or "default" if result would be empty
 */
export function toVaultName(name: string): string {
  const out = name
    .toLowerCase()
    .replace(VAULT_NAME_REGEX, "")
    .slice(0, VAULT_NAME_MAX);
  return out.length > 0 ? out : "default";
}

/**
 * Returns the vault name for a knowledge path (relative to data/).
 * agents/<id>/... -> vault <id>; user/, knowledge/, etc. -> "default".
 * @param path - Path relative to data/ (e.g. agents/maia/memory/foo.md, user/bar.md)
 */
export function vaultFromKnowledgePath(path: string): string {
  const norm = path.replace(/\\/g, "/").trim();
  if (norm.startsWith("agents/")) {
    const parts = norm.slice(7).split("/");
    if (parts[0]) return toVaultName(parts[0]);
  }
  return "default";
}
