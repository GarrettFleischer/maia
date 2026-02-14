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
  const { agentRegistry, threadService, taskMonitor, activeAgents } = deps;
  const router = gateway.getRouter();
  const json = (data: unknown, status = 200) => ({
    status,
    headers: { "Content-Type": "application/json" } as Record<string, string>,
    body: JSON.stringify(data),
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
