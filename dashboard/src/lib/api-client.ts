/**
 * @fileoverview REST API client for the Maia backend.
 * @module lib/api-client
 *
 * @brief Provides typed fetch wrappers for all dashboard API endpoints.
 * Uses relative URLs so the Vite proxy handles routing in dev, and
 * same-origin requests work in production.
 */

import type {
  Agent,
  AgentDetail,
  AgentTask,
  Thread,
  ThreadWithMessages,
  ThreadMessage,
} from "./types.js";

/**
 * @brief Gets the auth token from localStorage.
 * @returns Bearer token string or empty
 */
function getToken(): string {
  return localStorage.getItem("maia_token") ?? "";
}

/**
 * @brief Generic fetch wrapper with auth and JSON handling.
 * @param url - Relative API URL
 * @param options - Fetch options
 * @returns Parsed JSON response
 */
async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ─── Agents ──────────────────────────────────────────────────

/** @brief List all agents. */
export function fetchAgents(): Promise<Agent[]> {
  return apiFetch<Agent[]>("/api/agents");
}

/** @brief Get agent detail by ID. */
export function fetchAgent(id: string): Promise<AgentDetail> {
  return apiFetch<AgentDetail>(`/api/agents/${id}`);
}

// ─── Agent Tasks ─────────────────────────────────────────────

/** @brief Get tasks for an agent. */
export function fetchAgentTasks(agentId: string): Promise<AgentTask[]> {
  return apiFetch<AgentTask[]>(`/api/agents/${agentId}/tasks`);
}

/** @brief Add a task to an agent. */
export function addAgentTask(
  agentId: string,
  task: { description: string; scheduledAt: string; recurring?: string; prompt: string }
): Promise<AgentTask> {
  return apiFetch<AgentTask>(`/api/agents/${agentId}/tasks`, {
    method: "POST",
    body: JSON.stringify(task),
  });
}

/** @brief Remove a task from an agent. */
export function removeAgentTask(agentId: string, taskId: string): Promise<void> {
  return apiFetch<void>(`/api/agents/${agentId}/tasks/${taskId}`, {
    method: "DELETE",
  });
}

// ─── Threads ─────────────────────────────────────────────────

/** @brief List all threads, optionally filtered by participant. */
export function fetchThreads(participant?: string): Promise<Thread[]> {
  const params = participant ? `?participant=${encodeURIComponent(participant)}` : "";
  return apiFetch<Thread[]>(`/api/threads${params}`);
}

/** @brief Get a thread with its messages. */
export function fetchThread(id: string, limit = 50, offset = 0): Promise<ThreadWithMessages> {
  return apiFetch<ThreadWithMessages>(`/api/threads/${id}?limit=${limit}&offset=${offset}`);
}

/** @brief Post a message to a thread. */
export function postThreadMessage(
  threadId: string,
  content: string,
  senderId = "user",
  senderType = "user"
): Promise<ThreadMessage> {
  return apiFetch<ThreadMessage>(`/api/threads/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, senderId, senderType }),
  });
}

// ─── Chat ────────────────────────────────────────────────────

/** @brief Send a chat message to Maia (REST fallback). */
export function sendChat(
  message: string,
  senderId = "dashboard-user"
): Promise<{ reply: string; remembered?: Record<string, string> }> {
  return apiFetch<{ reply: string; remembered?: Record<string, string> }>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message, senderId }),
  });
}

// ─── Health ──────────────────────────────────────────────────

/** @brief Health check. */
export function fetchHealth(): Promise<{ ok: boolean; uptime: number; version: string }> {
  return apiFetch<{ ok: boolean; uptime: number; version: string }>("/api/health");
}
