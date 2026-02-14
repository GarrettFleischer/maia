/**
 * @fileoverview Shared TypeScript types for the Maia dashboard.
 * @module lib/types
 */

/** Agent configuration from the backend. */
export interface Agent {
  id: string;
  name: string;
  emoji: string;
  personality: string;
  createdBy: string;
  schedule: string;
  tools: string[];
  model: { provider: string; model: string };
  instructions?: string;
  active?: boolean;
  isRunning: boolean;
}

/** Agent with full detail (tasks, thread count). */
export interface AgentDetail extends Agent {
  tasks: AgentTask[];
  threadCount: number;
}

/** A single task from an agent's tasks.json. */
export interface AgentTask {
  id: string;
  description: string;
  scheduledAt: string;
  recurring: "once" | "hourly" | "daily" | "weekly" | null;
  status: "pending" | "completed" | "failed";
  prompt: string;
  createdAt: string;
  lastRunAt: string | null;
}

/** Conversation thread. */
export interface Thread {
  id: string;
  type: string;
  title: string | null;
  participants: string[];
  createdAt: string;
  updatedAt: string;
}

/** Thread with messages included. */
export interface ThreadWithMessages extends Thread {
  messages: ThreadMessage[];
}

/** A single message within a thread. */
export interface ThreadMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderType: "user" | "agent" | "maia";
  content: string;
  createdAt: string;
}

/** Agent DM push notification from WebSocket. */
export interface AgentDm {
  agentId: string;
  agentName: string;
  threadId: string;
  content: string;
}

/** Agent status update push from WebSocket. */
export interface AgentStatusUpdate {
  agentId: string;
  agentName: string;
  status: string;
  lastCheckin: string;
  summary: string;
}

/** Thread update push from WebSocket. */
export interface ThreadUpdate {
  threadId: string;
  message: {
    senderId: string;
    senderType: string;
    content: string;
    createdAt: string;
  };
}

/** Approval request push (tool proposal, agent creation, MCP server proposal, or flagged agent). */
export interface ApprovalRequest {
  type: "approval_request";
  id: string;
  kind: "tool_proposal" | "agent_creation_request" | "mcp_server_proposal" | "flagged_agent";
  summary: string;
  proposalId?: string;
  requestId?: string;
  toolName?: string;
  agentId?: string;
  agentName?: string;
  reason?: string;
  snippet?: string;
}

/** Status report push from Maia. */
export interface StatusReport {
  type: "status_report";
  title?: string;
  body?: string;
  severity?: string;
}
