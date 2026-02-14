/**
 * @fileoverview Repository for user-approved security snippets per agent.
 * @module security/approved-snippets
 *
 * @brief Only the user (via dashboard approval_response) can add approved snippets.
 * When an inline security flag's snippet is in this set for that agent, we do not stop the agent or show approval_request again.
 */

import type { CryptoProvider, Database, Logger } from "../core/types.js";

/**
 * @brief Dependencies for createApprovedSnippetsRepository.
 */
export interface ApprovedSnippetsRepositoryDeps {
  db: Database;
  crypto: CryptoProvider;
  logger: Logger;
}

/**
 * @brief Repository interface for agent approved snippets.
 */
export interface ApprovedSnippetsRepository {
  /** Returns true if this agent has this snippet approved (user-approved). */
  isApproved(agentId: string, snippet: string): Promise<boolean>;
  /** Adds the snippet for this agent. Only to be called from approval_response handler (user-initiated). */
  add(agentId: string, snippet: string): Promise<void>;
}

/**
 * @brief Creates the approved snippets repository.
 * @param deps - Database, crypto (for hashing snippet), logger
 * @returns ApprovedSnippetsRepository instance
 */
export function createApprovedSnippetsRepository(
  deps: ApprovedSnippetsRepositoryDeps
): ApprovedSnippetsRepository {
  const { db, crypto, logger } = deps;

  function snippetHash(snippet: string): string {
    return crypto.hash(snippet.trim());
  }

  return {
    async isApproved(agentId: string, snippet: string): Promise<boolean> {
      const hash = snippetHash(snippet);
      const rows = await db.query<{ agent_id: string }>(
        "SELECT 1 FROM agent_approved_snippets WHERE agent_id = ? AND snippet_hash = ?",
        [agentId, hash]
      );
      return rows.length > 0;
    },

    async add(agentId: string, snippet: string): Promise<void> {
      const hash = snippetHash(snippet);
      const now = new Date().toISOString();
      await db.execute(
        `INSERT OR IGNORE INTO agent_approved_snippets (agent_id, snippet_hash, approved_at) VALUES (?, ?, ?)`,
        [agentId, hash, now]
      );
      logger.debug("Approved snippet added", { agentId, snippetHash: hash });
    },
  };
}
