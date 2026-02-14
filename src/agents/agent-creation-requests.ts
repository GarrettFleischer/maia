/**
 * @fileoverview Repository for agent creation requests (flat agent architecture).
 * @module agents/agent-creation-requests
 *
 * @brief When a non-Maia agent calls create_agent, a request is stored for Maia/user
 * approval. Status flow: pending -> approved | denied. Name and soul are chosen by
 * the new agent after creation, not from the proposal.
 */

import type { Database, Logger } from "../core/types.js";
import type { AgentConfig } from "./registry.js";

/**
 * @brief Status of an agent creation request.
 */
export type AgentCreationRequestStatus = "pending" | "approved" | "denied";

/**
 * @brief A single agent creation request record.
 */
export interface AgentCreationRequest {
  id: string;
  requestingAgentId: string;
  /** Proposed config (id, schedule, tools, model, etc.). Name and personality are placeholders. */
  proposedConfig: Partial<AgentConfig> & { id: string };
  status: AgentCreationRequestStatus;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * @brief Input for creating a new agent creation request.
 */
export interface CreateAgentCreationRequestInput {
  id: string;
  requestingAgentId: string;
  /** Proposed config JSON (must include id; name/personality will be placeholders when agent is created). */
  proposedConfigJson: string;
}

/**
 * @brief Dependencies for createAgentCreationRequestsRepository.
 */
export interface AgentCreationRequestsRepositoryDeps {
  db: Database;
  logger: Logger;
}

/**
 * @brief Repository interface for agent creation requests.
 */
export interface AgentCreationRequestsRepository {
  create(input: CreateAgentCreationRequestInput): Promise<AgentCreationRequest>;
  getById(id: string): Promise<AgentCreationRequest | undefined>;
  updateStatus(id: string, status: AgentCreationRequestStatus): Promise<AgentCreationRequest | undefined>;
  listByStatus(status: AgentCreationRequestStatus): Promise<AgentCreationRequest[]>;
}

/**
 * @brief Creates the agent creation requests repository.
 * @param deps - Database and logger
 * @returns AgentCreationRequestsRepository instance
 *
 * @example
 * const repo = createAgentCreationRequestsRepository({ db, logger });
 * const req = await repo.create({ id: "...", requestingAgentId: "research-bot", proposedConfigJson: "..." });
 * await repo.updateStatus(req.id, "approved");
 */
export function createAgentCreationRequestsRepository(
  deps: AgentCreationRequestsRepositoryDeps
): AgentCreationRequestsRepository {
  const { db, logger } = deps;

  function rowToRequest(row: Record<string, unknown>): AgentCreationRequest {
    let proposedConfig: AgentCreationRequest["proposedConfig"];
    try {
      const parsed = JSON.parse((row.proposed_config_json as string) ?? "{}") as Record<string, unknown>;
      proposedConfig = { id: parsed.id as string, ...parsed } as AgentCreationRequest["proposedConfig"];
    } catch {
      proposedConfig = { id: (row.proposed_config_json as string) ? "unknown" : "" };
    }
    return {
      id: row.id as string,
      requestingAgentId: row.requesting_agent_id as string,
      proposedConfig,
      status: row.status as AgentCreationRequestStatus,
      createdAt: row.created_at as string,
      resolvedAt: (row.resolved_at as string | null) ?? null,
    };
  }

  return {
    async create(input: CreateAgentCreationRequestInput): Promise<AgentCreationRequest> {
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO agent_creation_requests (id, requesting_agent_id, proposed_config_json, status, created_at, resolved_at)
         VALUES (?, ?, ?, 'pending', ?, NULL)`,
        [input.id, input.requestingAgentId, input.proposedConfigJson, now]
      );
      const row = await db.query("SELECT * FROM agent_creation_requests WHERE id = ?", [input.id]);
      const r = row[0] as Record<string, unknown>;
      logger.debug("Agent creation request created", { id: input.id, requestingAgentId: input.requestingAgentId });
      return rowToRequest(r);
    },

    async getById(id: string): Promise<AgentCreationRequest | undefined> {
      const rows = await db.query("SELECT * FROM agent_creation_requests WHERE id = ?", [id]);
      if (rows.length === 0) return undefined;
      return rowToRequest(rows[0] as Record<string, unknown>);
    },

    async updateStatus(id: string, status: AgentCreationRequestStatus): Promise<AgentCreationRequest | undefined> {
      const resolvedAt = status !== "pending" ? new Date().toISOString() : null;
      await db.execute("UPDATE agent_creation_requests SET status = ?, resolved_at = ? WHERE id = ?", [
        status,
        resolvedAt,
        id,
      ]);
      const rows = await db.query("SELECT * FROM agent_creation_requests WHERE id = ?", [id]);
      if (rows.length === 0) return undefined;
      return rowToRequest(rows[0] as Record<string, unknown>);
    },

    async listByStatus(status: AgentCreationRequestStatus): Promise<AgentCreationRequest[]> {
      const rows = await db.query("SELECT * FROM agent_creation_requests WHERE status = ?", [status]);
      return (rows as Record<string, unknown>[]).map(rowToRequest);
    },
  };
}
