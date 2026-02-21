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
    original: historyEntriesSample,
    compressed: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
};

/** GET /api/settings — public settings (no raw API key). */
export const settingsPublic: SettingsPublic = {
  whitelistedModels: ["ollama/llama3.2", "openrouter/anthropic/claude-3.5-sonnet"],
  compressionModel: "ollama/llama3.2",
  heartbeatIntervalMinutes: 30,
  ollamaBaseUrl: "http://localhost:11434",
  hasOpenRouterKey: false,
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
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "agent-2",
      name: "Helper",
      model: "ollama/llama3.2",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
};
