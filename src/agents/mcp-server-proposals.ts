/**
 * @fileoverview Repository for MCP server proposals (agent-proposed MCPs for Docker hosting).
 * @module agents/mcp-server-proposals
 *
 * @brief When an agent proposes an MCP server (e.g. built in sandbox), a proposal is stored.
 * Status flow: pending_security -> security_denied | pending_user -> user_denied | user_approved.
 */

import type { Database, Logger } from "../core/types.js";

/**
 * @brief Status of an MCP server proposal.
 */
export type McpServerProposalStatus =
  | "pending_security"
  | "security_denied"
  | "pending_user"
  | "user_denied"
  | "user_approved";

/**
 * @brief A single MCP server proposal record.
 */
export interface McpServerProposal {
  id: string;
  proposingAgentId: string;
  name: string;
  description: string | null;
  sandboxPath: string;
  dockerfilePath: string | null;
  imageRef: string | null;
  status: McpServerProposalStatus;
  securityReason: string | null;
  userFeedback: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * @brief Input for creating a new MCP server proposal.
 */
export interface CreateMcpServerProposalInput {
  id: string;
  proposingAgentId: string;
  name: string;
  description?: string;
  sandboxPath: string;
  dockerfilePath?: string;
  imageRef?: string;
}

/**
 * @brief Dependencies for createMcpServerProposalsRepository.
 */
export interface McpServerProposalsRepositoryDeps {
  db: Database;
  logger: Logger;
}

/**
 * @brief Repository interface for MCP server proposals.
 */
export interface McpServerProposalsRepository {
  create(input: CreateMcpServerProposalInput): Promise<McpServerProposal>;
  getById(id: string): Promise<McpServerProposal | undefined>;
  updateStatus(
    id: string,
    status: McpServerProposalStatus,
    options?: { securityReason?: string; userFeedback?: string }
  ): Promise<McpServerProposal | undefined>;
  listByStatus(status: McpServerProposalStatus): Promise<McpServerProposal[]>;
}

/**
 * @brief Maps a DB row to McpServerProposal.
 */
function rowToProposal(row: Record<string, unknown>): McpServerProposal {
  return {
    id: row.id as string,
    proposingAgentId: row.proposing_agent_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    sandboxPath: row.sandbox_path as string,
    dockerfilePath: (row.dockerfile_path as string | null) ?? null,
    imageRef: (row.image_ref as string | null) ?? null,
    status: row.status as McpServerProposalStatus,
    securityReason: (row.security_reason as string | null) ?? null,
    userFeedback: (row.user_feedback as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * @brief Creates the MCP server proposals repository.
 * @param deps - Database and logger
 * @returns McpServerProposalsRepository instance
 *
 * @example
 * const repo = createMcpServerProposalsRepository({ db, logger });
 * const p = await repo.create({ id: "...", proposingAgentId: "bot", name: "my-mcp", sandboxPath: "/workspace/bot/mcp" });
 * await repo.updateStatus(p.id, "pending_user");
 */
export function createMcpServerProposalsRepository(
  deps: McpServerProposalsRepositoryDeps
): McpServerProposalsRepository {
  const { db, logger } = deps;

  return {
    async create(input: CreateMcpServerProposalInput): Promise<McpServerProposal> {
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO mcp_server_proposals (
          id, proposing_agent_id, name, description, sandbox_path, dockerfile_path, image_ref,
          status, security_reason, user_feedback, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_security', NULL, NULL, ?, ?)`,
        [
          input.id,
          input.proposingAgentId,
          input.name,
          input.description ?? null,
          input.sandboxPath,
          input.dockerfilePath ?? null,
          input.imageRef ?? null,
          now,
          now,
        ]
      );
      const rows = await db.query("SELECT * FROM mcp_server_proposals WHERE id = ?", [input.id]);
      const r = rows[0] as Record<string, unknown>;
      logger.debug("MCP server proposal created", {
        id: input.id,
        proposingAgentId: input.proposingAgentId,
        name: input.name,
      });
      return rowToProposal(r);
    },

    async getById(id: string): Promise<McpServerProposal | undefined> {
      const rows = await db.query("SELECT * FROM mcp_server_proposals WHERE id = ?", [id]);
      if (rows.length === 0) return undefined;
      return rowToProposal(rows[0] as Record<string, unknown>);
    },

    async updateStatus(
      id: string,
      status: McpServerProposalStatus,
      options?: { securityReason?: string; userFeedback?: string }
    ): Promise<McpServerProposal | undefined> {
      const now = new Date().toISOString();
      const securityReason = options?.securityReason ?? null;
      const userFeedback = options?.userFeedback ?? null;
      await db.execute(
        `UPDATE mcp_server_proposals SET status = ?, updated_at = ?,
         security_reason = COALESCE(?, security_reason), user_feedback = COALESCE(?, user_feedback) WHERE id = ?`,
        [status, now, securityReason, userFeedback, id]
      );
      const rows = await db.query("SELECT * FROM mcp_server_proposals WHERE id = ?", [id]);
      if (rows.length === 0) return undefined;
      return rowToProposal(rows[0] as Record<string, unknown>);
    },

    async listByStatus(status: McpServerProposalStatus): Promise<McpServerProposal[]> {
      const rows = await db.query("SELECT * FROM mcp_server_proposals WHERE status = ?", [status]);
      return (rows as Record<string, unknown>[]).map(rowToProposal);
    },
  };
}
