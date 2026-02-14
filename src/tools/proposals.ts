/**
 * @fileoverview Repository for agent-created tool proposals and check-in security metadata.
 * @module tools/proposals
 *
 * @brief Persists tool proposals (pending_security -> security_denied | pending_user -> user_denied | user_approved)
 * and last check-in security run timestamp for the orchestrator.
 */

import type { Database, Logger } from "../core/types.js";

/**
 * @brief Tool proposal status in the approval flow.
 */
export type ToolProposalStatus =
  | "pending_security"
  | "security_denied"
  | "pending_user"
  | "user_denied"
  | "user_approved";

/**
 * @brief Implementation type for a proposed tool (e.g. inline code, template).
 */
export interface ToolProposalImplementation {
  type: string;
  /** JSON-serializable config (e.g. code, template id). */
  config?: Record<string, unknown>;
}

/**
 * @brief A single tool proposal record.
 */
export interface ToolProposal {
  id: string;
  proposingAgentId: string;
  name: string;
  description: string;
  parametersJson: string;
  implementationType: string;
  implementationConfigJson: string | null;
  status: ToolProposalStatus;
  securityReason: string | null;
  userFeedback: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * @brief Input for creating a new tool proposal.
 */
export interface CreateToolProposalInput {
  id: string;
  proposingAgentId: string;
  name: string;
  description: string;
  parametersJson: string;
  implementationType: string;
  implementationConfigJson?: string | null;
}

/**
 * @brief Dependencies for createToolProposalsRepository.
 */
export interface ToolProposalsRepositoryDeps {
  db: Database;
  logger: Logger;
}

/**
 * @brief Repository interface for tool proposals and check-in metadata.
 */
export interface ToolProposalsRepository {
  create(input: CreateToolProposalInput): Promise<ToolProposal>;
  getById(id: string): Promise<ToolProposal | undefined>;
  updateStatus(
    id: string,
    status: ToolProposalStatus,
    options?: { securityReason?: string | null; userFeedback?: string | null }
  ): Promise<ToolProposal | undefined>;
  listByStatus(status: ToolProposalStatus): Promise<ToolProposal[]>;
  getLastCheckinSecurityAt(): Promise<string | null>;
  setLastCheckinSecurityAt(isoTimestamp: string): Promise<void>;
}

/**
 * @brief Creates the tool proposals repository.
 * @param deps - Database and logger
 * @returns ToolProposalsRepository instance
 *
 * @example
 * const repo = createToolProposalsRepository({ db, logger });
 * const p = await repo.create({ id: "...", proposingAgentId: "maia", name: "my_tool", ... });
 * await repo.updateStatus(p.id, "security_denied", { securityReason: "SSRF risk" });
 */
export function createToolProposalsRepository(deps: ToolProposalsRepositoryDeps): ToolProposalsRepository {
  const { db, logger } = deps;

  function rowToProposal(row: Record<string, unknown>): ToolProposal {
    return {
      id: row.id as string,
      proposingAgentId: row.proposing_agent_id as string,
      name: row.name as string,
      description: row.description as string,
      parametersJson: row.parameters_json as string,
      implementationType: row.implementation_type as string,
      implementationConfigJson: (row.implementation_config_json as string | null) ?? null,
      status: row.status as ToolProposalStatus,
      securityReason: (row.security_reason as string | null) ?? null,
      userFeedback: (row.user_feedback as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  return {
    async create(input: CreateToolProposalInput): Promise<ToolProposal> {
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO tool_proposals (
          id, proposing_agent_id, name, description, parameters_json,
          implementation_type, implementation_config_json, status,
          security_reason, user_feedback, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_security', NULL, NULL, ?, ?)`,
        [
          input.id,
          input.proposingAgentId,
          input.name,
          input.description,
          input.parametersJson,
          input.implementationType,
          input.implementationConfigJson ?? null,
          now,
          now,
        ]
      );
      const row = (await db.query<Record<string, unknown>>(
        "SELECT * FROM tool_proposals WHERE id = ?",
        [input.id]
      ))[0];
      if (!row) throw new Error("Failed to read created tool proposal");
      logger.debug("Tool proposal created", { id: input.id, name: input.name });
      return rowToProposal(row);
    },

    async getById(id: string): Promise<ToolProposal | undefined> {
      const rows = await db.query<Record<string, unknown>>(
        "SELECT * FROM tool_proposals WHERE id = ?",
        [id]
      );
      if (rows.length === 0) return undefined;
      return rowToProposal(rows[0]);
    },

    async updateStatus(
      id: string,
      status: ToolProposalStatus,
      options?: { securityReason?: string | null; userFeedback?: string | null }
    ): Promise<ToolProposal | undefined> {
      const now = new Date().toISOString();
      const securityReason = options?.securityReason !== undefined ? options.securityReason : undefined;
      const userFeedback = options?.userFeedback !== undefined ? options.userFeedback : undefined;

      if (securityReason !== undefined && userFeedback !== undefined) {
        await db.execute(
          "UPDATE tool_proposals SET status = ?, security_reason = ?, user_feedback = ?, updated_at = ? WHERE id = ?",
          [status, securityReason, userFeedback, now, id]
        );
      } else if (securityReason !== undefined) {
        await db.execute(
          "UPDATE tool_proposals SET status = ?, security_reason = ?, updated_at = ? WHERE id = ?",
          [status, securityReason, now, id]
        );
      } else if (userFeedback !== undefined) {
        await db.execute(
          "UPDATE tool_proposals SET status = ?, user_feedback = ?, updated_at = ? WHERE id = ?",
          [status, userFeedback, now, id]
        );
      } else {
        await db.execute("UPDATE tool_proposals SET status = ?, updated_at = ? WHERE id = ?", [
          status,
          now,
          id,
        ]);
      }
      const rows = await db.query<Record<string, unknown>>(
        "SELECT * FROM tool_proposals WHERE id = ?",
        [id]
      );
      return rows.length > 0 ? rowToProposal(rows[0]) : undefined;
    },

    async listByStatus(status: ToolProposalStatus): Promise<ToolProposal[]> {
      const rows = await db.query<Record<string, unknown>>(
        "SELECT * FROM tool_proposals WHERE status = ? ORDER BY created_at ASC",
        [status]
      );
      return rows.map(rowToProposal);
    },

    async getLastCheckinSecurityAt(): Promise<string | null> {
      const rows = await db.query<Record<string, unknown>>(
        "SELECT value FROM key_value WHERE key = 'last_checkin_security_at'"
      );
      if (rows.length === 0) return null;
      return (rows[0].value as string) ?? null;
    },

    async setLastCheckinSecurityAt(isoTimestamp: string): Promise<void> {
      await db.execute(
        `INSERT INTO key_value (key, value) VALUES ('last_checkin_security_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = ?`,
        [isoTimestamp, isoTimestamp]
      );
    },
  };
}
