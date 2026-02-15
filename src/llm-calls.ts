/**
 * @fileoverview Repository for LLM call history (prompt/response audit).
 * @module llm-calls
 *
 * @brief Persists each LLM request/response round for Maia and sub-agents,
 * with optional thread association for per-thread views in the dashboard.
 */

import type { Database, Logger } from "./core/types.js";

/**
 * @brief A single LLM call record (request + response).
 */
export interface LlmCall {
  id: string;
  agentId: string;
  sessionId: string;
  threadId: string | null;
  requestMessages: Array<{ role: string; content: string; name?: string }>;
  responseContent: string;
  responseToolCalls: unknown[] | null;
  createdAt: string;
}

/**
 * @brief Input for creating an LLM call record.
 */
export interface CreateLlmCallInput {
  id: string;
  agentId: string;
  sessionId: string;
  threadId?: string | null;
  requestMessages: Array<{ role: string; content: string; name?: string }>;
  responseContent: string;
  responseToolCalls?: unknown[] | null;
}

/**
 * @brief Options for listing LLM calls (filters and pagination).
 */
export interface ListLlmCallsOptions {
  agentId?: string;
  threadId?: string;
  since?: string;
  limit?: number;
}

/**
 * @brief Dependencies for createLlmCallsRepository.
 */
export interface LlmCallsRepositoryDeps {
  db: Database;
  logger: Logger;
}

/**
 * @brief Repository interface for LLM call history.
 */
export interface LlmCallsRepository {
  create(input: CreateLlmCallInput): Promise<LlmCall>;
  list(options?: ListLlmCallsOptions): Promise<LlmCall[]>;
}

function rowToLlmCall(row: Record<string, unknown>): LlmCall {
  let requestMessages: LlmCall["requestMessages"] = [];
  try {
    requestMessages = JSON.parse((row.request_messages as string) ?? "[]") as LlmCall["requestMessages"];
  } catch {
    // ignore
  }
  let responseToolCalls: unknown[] | null = null;
  try {
    const raw = row.response_tool_calls as string | null | undefined;
    if (raw) responseToolCalls = JSON.parse(raw) as unknown[];
  } catch {
    // ignore
  }
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    sessionId: row.session_id as string,
    threadId: (row.thread_id as string | null) ?? null,
    requestMessages,
    responseContent: (row.response_content as string) ?? "",
    responseToolCalls,
    createdAt: row.created_at as string,
  };
}

/**
 * @brief Creates the LLM calls repository.
 * @param deps - Database and logger
 * @returns LlmCallsRepository instance
 *
 * @example
 * const repo = createLlmCallsRepository({ db, logger });
 * await repo.create({ id: "...", agentId: "maia", sessionId: "...", requestMessages: [...], responseContent: "..." });
 * const calls = await repo.list({ threadId: "thread-1", limit: 50 });
 */
export function createLlmCallsRepository(deps: LlmCallsRepositoryDeps): LlmCallsRepository {
  const { db, logger } = deps;

  return {
    async create(input: CreateLlmCallInput): Promise<LlmCall> {
      const now = new Date().toISOString();
      const requestMessagesJson = JSON.stringify(input.requestMessages);
      const responseToolCallsJson = input.responseToolCalls?.length
        ? JSON.stringify(input.responseToolCalls)
        : null;
      await db.execute(
        `INSERT INTO llm_calls (id, agent_id, session_id, thread_id, request_messages, response_content, response_tool_calls, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.agentId,
          input.sessionId,
          input.threadId ?? null,
          requestMessagesJson,
          input.responseContent,
          responseToolCallsJson,
          now,
        ]
      );
      const rows = await db.query<Record<string, unknown>>("SELECT * FROM llm_calls WHERE id = ?", [input.id]);
      logger.debug("LLM call recorded", { id: input.id, agentId: input.agentId, threadId: input.threadId });
      return rowToLlmCall(rows[0]!);
    },

    async list(options?: ListLlmCallsOptions): Promise<LlmCall[]> {
      const limit = Math.min(options?.limit ?? 50, 500);
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (options?.agentId) {
        conditions.push("agent_id = ?");
        params.push(options.agentId);
      }
      if (options?.threadId) {
        conditions.push("thread_id = ?");
        params.push(options.threadId);
      }
      if (options?.since) {
        conditions.push("created_at >= ?");
        params.push(options.since);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit);
      const rows = await db.query<Record<string, unknown>>(
        `SELECT * FROM llm_calls ${where} ORDER BY created_at DESC LIMIT ?`,
        params
      );
      return rows.map(rowToLlmCall);
    },
  };
}
