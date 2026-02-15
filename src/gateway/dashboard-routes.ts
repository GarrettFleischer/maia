/**
 * @fileoverview Dashboard API routes for agent management, threads, and tasks.
 * @module gateway/dashboard-routes
 *
 * @brief Registers REST API endpoints for the Preact dashboard:
 * - GET/POST/DELETE for agents and agent tasks
 * - GET/POST for threads and thread messages
 * All routes require Bearer token auth (handled by gateway middleware).
 */

import type { GatewayServer } from "./server.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { ThreadService } from "../threads/service.js";
import type { TaskMonitor } from "../agents/task-monitor.js";
import type { SubAgent } from "../agents/factory.js";
import type { AuditLog, AuditEventType } from "../core/types.js";
import type { LlmCallsRepository } from "../llm-calls.js";
import type { ApprovedDashboardWidgetsRepository } from "../agents/approved-dashboard-widgets.js";

/**
 * @brief Dependencies for dashboard route registration.
 */
export interface DashboardRouteDeps {
  /** Agent registry for CRUD operations */
  agentRegistry: AgentRegistry;
  /** Thread service for conversation threading */
  threadService: ThreadService;
  /** Task monitor for reading/writing agent tasks */
  taskMonitor: TaskMonitor;
  /** Active sub-agent runtimes */
  activeAgents: Map<string, SubAgent>;
  /** Optional audit log for GET /api/audit/entries */
  auditLog?: AuditLog;
  /** Optional LLM calls repository for GET /api/llm-calls and GET /api/threads/:id/llm-calls */
  llmCallsRepo?: LlmCallsRepository;
  /** Optional approved dashboard widgets repo for GET /api/agents/:id/dashboard */
  approvedDashboardWidgetsRepo?: ApprovedDashboardWidgetsRepository;
}

/**
 * @brief Registers all dashboard API routes on the gateway.
 * @param gateway - GatewayServer to register routes on
 * @param deps - Dependencies for route handlers
 *
 * @note Routes registered:
 * - GET /api/agents - list all agents with status
 * - GET /api/agents/:id - agent detail
 * - GET /api/agents/:id/tasks - get agent tasks
 * - POST /api/agents/:id/tasks - add a task to an agent
 * - DELETE /api/agents/:id/tasks/:taskId - remove a task
 * - GET /api/threads - list threads (optional ?participant= filter)
 * - GET /api/threads/:id - get thread with messages
 * - POST /api/threads/:id/messages - post a message to a thread
 */
export function registerDashboardRoutes(
  gateway: GatewayServer,
  deps: DashboardRouteDeps
): void {
  const { agentRegistry, threadService, taskMonitor, activeAgents, auditLog, llmCallsRepo, approvedDashboardWidgetsRepo } = deps;
  const router = gateway.getRouter();
  const json = (data: unknown, status = 200) => ({
    status,
    headers: { "Content-Type": "application/json" } as Record<string, string>,
    body: JSON.stringify(data),
  });

  // ─── Audit ───────────────────────────────────────────────────

  /**
   * @brief GET /api/audit/entries - List audit log entries with optional filters.
   * @param type - Optional event type filter (e.g. TOOL_EXECUTION)
   * @param since - Optional ISO date string; only entries at or after this time
   * @param limit - Optional max number of entries (default 100)
   * @returns JSON array of audit entries
   */
  router.get("/api/audit/entries", async (req) => {
    if (!auditLog) {
      return json({ error: "Audit log not available" }, 503);
    }
    try {
      const typeParam = req.query.type;
      const sinceParam = req.query.since;
      const limitParam = req.query.limit;

      const type = typeParam as AuditEventType | undefined;
      const since = sinceParam ? new Date(sinceParam) : undefined;
      const limit = limitParam ? parseInt(limitParam, 10) : 100;
      const safeLimit = Number.isNaN(limit) || limit <= 0 ? 100 : Math.min(limit, 1000);

      const entries = await auditLog.read({ type, since, limit: safeLimit });
      return json(entries);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── LLM calls (prompt/response audit) ───────────────────────

  /**
   * @brief GET /api/llm-calls - List LLM call records with optional filters.
   * @param threadId - Optional thread ID filter
   * @param agentId - Optional agent ID filter
   * @param since - Optional ISO date filter
   * @param limit - Optional limit (default 50)
   * @returns JSON array of LLM call records
   */
  router.get("/api/llm-calls", async (req) => {
    if (!llmCallsRepo) {
      return json({ error: "LLM calls repository not available" }, 503);
    }
    try {
      const threadId = req.query.threadId;
      const agentId = req.query.agentId;
      const since = req.query.since;
      const limitParam = req.query.limit;
      const limit = limitParam ? parseInt(limitParam, 10) : 50;
      const safeLimit = Number.isNaN(limit) || limit <= 0 ? 50 : Math.min(limit, 500);
      const entries = await llmCallsRepo.list({ threadId, agentId, since, limit: safeLimit });
      return json(entries);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * @brief GET /api/threads/:id/llm-calls - List LLM calls for a specific thread.
   * @param id - Thread ID
   * @returns JSON array of LLM call records for that thread
   */
  router.get("/api/threads/:id/llm-calls", async (req) => {
    if (!llmCallsRepo) {
      return json({ error: "LLM calls repository not available" }, 503);
    }
    try {
      const threadId = req.params.id;
      const limitParam = req.query.limit;
      const limit = limitParam ? parseInt(limitParam, 10) : 50;
      const safeLimit = Number.isNaN(limit) || limit <= 0 ? 50 : Math.min(limit, 500);
      const entries = await llmCallsRepo.list({ threadId, limit: safeLimit });
      return json(entries);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Agents ──────────────────────────────────────────────────

  /**
   * @brief GET /api/agents - List all agents with status info.
   * @returns JSON array of agent configs with active status
   */
  router.get("/api/agents", async () => {
    try {
      const agents = await agentRegistry.list();
      const result = agents.map((a) => ({
        ...a,
        isRunning: activeAgents.has(a.id),
      }));
      return json(result);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * @brief GET /api/agents/:id - Get agent detail.
   * @param id - Agent identifier
   * @returns JSON agent config with tasks and thread count
   */
  router.get("/api/agents/:id", async (req) => {
    try {
      const config = await agentRegistry.get(req.params.id);
      if (!config) {
        return json({ error: "Agent not found" }, 404);
      }

      const tasks = await taskMonitor.getTasks(req.params.id);
      const threads = await threadService.listThreads(req.params.id);

      return json({
        ...config,
        isRunning: activeAgents.has(req.params.id),
        tasks,
        threadCount: threads.length,
      });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * @brief GET /api/agents/:id/dashboard - Get agent dashboard config and approved widgets.
   * @param id - Agent identifier
   * @returns JSON with layout, panels (optional), and approvedWidgets array
   */
  router.get("/api/agents/:id/dashboard", async (req) => {
    try {
      const agentId = req.params.id;
      const config = await agentRegistry.get(agentId);
      if (!config) {
        return json({ error: "Agent not found" }, 404);
      }
      const approvedWidgets = approvedDashboardWidgetsRepo
        ? await approvedDashboardWidgetsRepo.listByAgent(agentId)
        : [];
      return json({
        layout: "chat_only",
        panels: [],
        approvedWidgets: approvedWidgets.map((w) => ({
          id: w.id,
          agentId: w.agentId,
          widgetId: w.widgetId,
          name: w.name,
          html: w.html,
          css: w.css,
          js: w.js,
          createdAt: w.createdAt,
        })),
      });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Agent Tasks ─────────────────────────────────────────────

  /**
   * @brief GET /api/agents/:id/tasks - Get an agent's tasks.
   * @param id - Agent identifier
   * @returns JSON array of tasks
   */
  router.get("/api/agents/:id/tasks", async (req) => {
    try {
      const tasks = await taskMonitor.getTasks(req.params.id);
      return json(tasks);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * @brief POST /api/agents/:id/tasks - Add a task to an agent.
   * @param id - Agent identifier
   * @returns JSON of the created task
   *
   * @note Request body: { description, scheduledAt, recurring?, prompt }
   */
  router.post("/api/agents/:id/tasks", async (req) => {
    try {
      const body = JSON.parse(req.body) as {
        description: string;
        scheduledAt: string;
        recurring?: string;
        prompt: string;
      };

      if (!body.description || !body.scheduledAt || !body.prompt) {
        return json({ error: "description, scheduledAt, and prompt are required" }, 400);
      }

      const task = await taskMonitor.addTask(req.params.id, {
        description: body.description,
        scheduledAt: body.scheduledAt,
        recurring: (body.recurring as "once" | "hourly" | "daily" | "weekly") ?? "once",
        prompt: body.prompt,
      });

      return json(task, 201);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * @brief DELETE /api/agents/:id/tasks/:taskId - Remove a task.
   * @param id - Agent identifier
   * @param taskId - Task identifier
   * @returns JSON success or 404
   */
  router.delete("/api/agents/:id/tasks/:taskId", async (req) => {
    try {
      const removed = await taskMonitor.removeTask(req.params.id, req.params.taskId);
      if (!removed) {
        return json({ error: "Task not found" }, 404);
      }
      return json({ ok: true });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ─── Threads ─────────────────────────────────────────────────

  /**
   * @brief GET /api/threads - List threads.
   * @param participant - Optional query param to filter by participant ID
   * @returns JSON array of threads
   */
  router.get("/api/threads", async (req) => {
    try {
      const participant = req.query.participant;
      const threads = await threadService.listThreads(participant || undefined);
      return json(threads);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * @brief GET /api/threads/:id - Get thread with messages.
   * @param id - Thread identifier
   * @returns JSON thread object with messages array
   *
   * @note Supports pagination via ?limit= and ?offset= query params (default: 50, 0)
   */
  router.get("/api/threads/:id", async (req) => {
    try {
      const thread = await threadService.getThread(req.params.id);
      if (!thread) {
        return json({ error: "Thread not found" }, 404);
      }

      const limit = parseInt(req.query.limit ?? "50", 10);
      const offset = parseInt(req.query.offset ?? "0", 10);
      const messages = await threadService.getMessages(req.params.id, limit, offset);

      return json({ ...thread, messages });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * @brief POST /api/threads/:id/messages - Post a message to a thread.
   * @param id - Thread identifier
   * @returns JSON of the created message
   *
   * @note Request body: { content, senderId?, senderType? }
   * Defaults: senderId = "user", senderType = "user"
   */
  router.post("/api/threads/:id/messages", async (req) => {
    try {
      const body = JSON.parse(req.body) as {
        content: string;
        senderId?: string;
        senderType?: string;
      };

      if (!body.content) {
        return json({ error: "content is required" }, 400);
      }

      const thread = await threadService.getThread(req.params.id);
      if (!thread) {
        return json({ error: "Thread not found" }, 404);
      }

      const message = await threadService.addMessage(
        req.params.id,
        body.senderId ?? "user",
        (body.senderType ?? "user") as "user" | "agent" | "maia",
        body.content
      );

      return json(message, 201);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
