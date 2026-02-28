/**
 * @fileoverview Fixture data for UI/component tests (sessions, settings, agents).
 * @module __tests__/helpers/fixtures
 */

import type { Session, SettingsPublic, AgentDefinition, HistoryEntry } from "@/lib/types";

/** GET /api/sessions/active with no active session. */
export const sessionActiveEmpty: { sessionId: string | null; session: Session | null } = {
  sessionId: null,
  session: null,
};

/** One user and one agent message for session.original. */
export const historyEntriesSample: HistoryEntry[] = [
  {
    id: "e1",
    role: "user",
    content: "Hello",
    timestamp: new Date().toISOString(),
  },
  {
    id: "e2",
    role: "agent",
    content: "Hi there!",
    timestamp: new Date().toISOString(),
  },
];

/** GET /api/sessions/active with an active session and messages. */
export const sessionActiveWithMessages: {
  sessionId: string;
  session: Session;
} = {
  sessionId: "session-1",
  session: {
    id: "session-1",
    name: "",
    description: "",
    participants: ["user", "maia"],
    tags: [],
    type: "user",
    original: historyEntriesSample,
    compressed: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
};

/** GET /api/sessions/active with a session chatting with a non-maia agent (for targetAgent tests). */
export const sessionActiveWithCustomAgent: {
  sessionId: string;
  session: Session;
} = {
  sessionId: "session-custom",
  session: {
    id: "session-custom",
    name: "",
    description: "",
    participants: ["user", "custom-agent"],
    tags: [],
    type: "user",
    original: historyEntriesSample,
    compressed: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
};

/** GET /api/settings — public settings (no raw API key). */
export const settingsPublic: SettingsPublic = {
  whitelistedModels: ["ollama/llama3.2", "ollama/qwen2.5-coder", "ollama/nomic-embed-text", "openrouter/anthropic/claude-3.5-sonnet"],
  heartbeatIntervalMinutes: 30,
  ollamaBaseUrl: "http://localhost:11434",
  hasOllamaKey: false,
  hasOpenRouterKey: false,
  hasBraveKey: false,
  hasBraveAnswersKey: false,
  embeddingModel: "ollama/nomic-embed-text",
  embedMaxContentLength: 4000,
  contextQueryModel: "",
  contextSummaryModel: "",
  contextRecentTurns: 3,
  contextReasoningEffort: "medium",
  archiveDurationValue: 0,
  archiveDurationUnit: "days",
  modelParams: {},
};

/** GET /api/model-capabilities — capabilities for whitelisted models. */
export const modelCapabilitiesFixture: {
  modelCapabilities: Record<string, { provider: string; supportsReasoning: boolean }>;
} = {
  modelCapabilities: {
    "ollama/llama3.2": { provider: "ollama", supportsReasoning: true },
    "ollama/qwen2.5-coder": { provider: "ollama", supportsReasoning: true },
    "ollama/nomic-embed-text": { provider: "ollama", supportsReasoning: false },
    "openrouter/anthropic/claude-3.5-sonnet": { provider: "openrouter", supportsReasoning: true },
  },
};

/** GET /api/settings with OpenRouter key already configured. */
export const settingsPublicWithKey: SettingsPublic = {
  ...settingsPublic,
  hasOpenRouterKey: true,
};

/** GET /api/agents — empty list. */
export const agentsEmpty: { agents: AgentDefinition[] } = {
  agents: [],
};

/** GET /api/agents — list with maia and one other agent. */
export const agentsList: { agents: AgentDefinition[] } = {
  agents: [
    {
      id: "maia",
      name: "Maia",
      model: "ollama/llama3.2",
      reasoningEffort: "medium",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "agent-2",
      name: "Helper",
      model: "ollama/qwen2.5-coder",
      reasoningEffort: "medium",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
};

/** Dashboard response shape for GET /api/dashboard. */
export interface DashboardFixture {
  agents: AgentDefinition[];
  taskCountsByStatus: { todo: number; in_progress: number; done: number };
  taskCountsByAgent: Record<string, { todo: number; in_progress: number; done: number }>;
  recentAgentSessions: { id: string; name: string; participants: string[]; updatedAt: string }[];
  cronJobs: { id: string; expression: string; taskDescription: string; agentId: string; isBuiltIn: boolean; createdAt: string }[];
}

/** GET /api/dashboard — empty (no agents). */
export const dashboardEmpty: DashboardFixture = {
  agents: [],
  taskCountsByStatus: { todo: 0, in_progress: 0, done: 0 },
  taskCountsByAgent: {},
  recentAgentSessions: [],
  cronJobs: [],
};

/** GET /api/dashboard — with agents, task counts, recent sessions, cron. */
export const dashboardWithData: DashboardFixture = {
  agents: agentsList.agents,
  taskCountsByStatus: { todo: 2, in_progress: 1, done: 3 },
  taskCountsByAgent: {
    maia: { todo: 0, in_progress: 1, done: 2 },
    "agent-2": { todo: 1, in_progress: 0, done: 0 },
  },
  recentAgentSessions: [
    {
      id: "session-1",
      name: "Agent run",
      participants: ["maia", "agent-2"],
      updatedAt: new Date().toISOString(),
    },
  ],
  cronJobs: [
    {
      id: "builtin-heartbeat",
      expression: "*/30 * * * *",
      taskDescription: "Heartbeat",
      agentId: "maia",
      isBuiltIn: true,
      createdAt: new Date().toISOString(),
    },
  ],
};
