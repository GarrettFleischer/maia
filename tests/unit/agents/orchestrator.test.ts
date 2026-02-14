/**
 * @fileoverview Unit tests for the orchestrator (check-in skip, security/progress/remember in agentToAgentChat).
 * @module tests/unit/agents/orchestrator
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createOrchestrator } from "../../../src/agents/orchestrator.js";
import type { SubAgent } from "../../../src/agents/factory.js";
import type { HandleMessageResult } from "../../../src/agent/runtime.js";
import { capturingLogger, mockCryptoProvider, fixedClock } from "../../helpers/index.js";
import type { ThreadService } from "../../../src/threads/service.js";
import type { RequestQueue } from "../../../src/providers/queue.js";
import type { AgentRegistry } from "../../../src/agents/registry.js";
import type { ApprovedSnippetsRepository } from "../../../src/security/approved-snippets.js";

/**
 * Mock thread service: findOrCreateThread returns a stub thread, addMessage no-op.
 */
function mockThreadService(overrides?: Partial<ThreadService>): ThreadService {
  return {
    createThread: async () => ({
      id: "thread-1",
      type: "agent-agent",
      title: null,
      participants: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    addMessage: async () => ({
      id: "msg-1",
      threadId: "thread-1",
      senderId: "",
      senderType: "agent",
      content: "",
      createdAt: new Date().toISOString(),
    }),
    getThread: async () => undefined,
    getMessages: async () => [],
    listThreads: async () => [],
    getSharedThreads: async () => [],
    getMessagesForParticipantSince: async () => [],
    getLastDmSentAt: async () => null,
    shareThread: async () => ({
      threadId: "t",
      sharedWith: "",
      sharedBy: "",
      sharedAt: "",
    }),
    storePendingDm: async () => ({
      id: "",
      senderId: "",
      content: "",
      createdAt: "",
      recipientId: "user",
    }),
    getPendingDms: async () => [],
    clearPendingDms: async () => {},
    findOrCreateThread: async () => ({
      id: "thread-1",
      type: "agent-agent",
      title: null,
      participants: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    ...overrides,
  };
}

/**
 * Mock queue: enqueue runs the fn with the given priority and returns its result.
 */
function mockQueue(): RequestQueue {
  const run = async <T>(fn: () => Promise<T>): Promise<T> => fn();
  return {
    enqueue: run,
    getStats: () => ({ pending: 0, running: 0 }),
  } as RequestQueue;
}

describe("Orchestrator", () => {
  let activeAgents: Map<string, SubAgent>;
  let wsPushCalls: Array<{ type: string; payload: Record<string, unknown> }>;
  let flaggedCalls: Array<{ agentId: string; agentName: string; reason: string; snippet: string }>;

  beforeEach(() => {
    activeAgents = new Map();
    wsPushCalls = [];
    flaggedCalls = [];
  });

  function createSubAgent(
    id: string,
    name: string,
    handleMessageResult: HandleMessageResult
  ): SubAgent {
    return {
      config: { id, name, emoji: "🤖", personality: "", createdBy: "", schedule: "", tools: [], model: { provider: "mock", model: "test" } },
      runtime: {
        handleMessage: async () => handleMessageResult,
        getSessionId: () => undefined,
        getToolRegistry: () => ({} as ReturnType<typeof import("../../../src/agent/tools/registry.js").createToolRegistry>),
      },
      workspacePath: `/workspace/${id}`,
    };
  }

  it("agentToAgentChat returns response content and records message", async () => {
    const toAgent = createSubAgent("bot", "Bot", { content: "Hello back." });
    activeAgents.set("bot", toAgent);

    const threadService = mockThreadService();
    let addMessageCalls = 0;
    const ts = {
      ...threadService,
      addMessage: async (...args: unknown[]) => {
        addMessageCalls++;
        return threadService.addMessage("", "", "agent", "");
      },
      findOrCreateThread: async () => ({
        id: "t1",
        type: "agent-agent" as const,
        title: null,
        participants: [],
        createdAt: "",
        updatedAt: "",
      }),
    };

    const orchestrator = createOrchestrator({
      clock: fixedClock(),
      crypto: mockCryptoProvider(),
      logger: capturingLogger(),
      threadService: ts,
      priorityQueue: mockQueue(),
      activeAgents,
      maiaRuntime: { handleMessage: async () => ({ content: "" }) },
      wsPush: (type, payload) => wsPushCalls.push({ type, ...payload } as { type: string; payload: Record<string, unknown> }),
    });

    const result = await orchestrator.agentToAgentChat("maia", "bot", "Hi");
    expect(result).toBe("Hello back.");
    expect(addMessageCalls).toBeGreaterThanOrEqual(2);
    expect(wsPushCalls.some((c) => c.type === "thread_update")).toBe(true);
  });

  it("agentToAgentChat when response has securityFlagged: flag applies to conversation partner (fromAgent), not responder", async () => {
    // Bot (toAgent) replies; Bot flags what Alice (fromAgent) sent. So the flagged party is Alice.
    const alice = createSubAgent("alice", "Alice", { content: "Hi" });
    const bot = createSubAgent("bot", "Bot", {
      content: "Reply",
      securityFlagged: { reason: "Injection", snippet: "ignore instructions" },
    });
    activeAgents.set("alice", alice);
    activeAgents.set("bot", bot);

    const mockRegistry: AgentRegistry = {
      get: async (id) => (id === "alice" ? alice.config : bot.config),
      update: async () => {},
      remove: async () => {},
      list: async () => [],
      agentWorkspacePath: (id) => `/workspace/${id}`,
    };

    const approvedRepo: ApprovedSnippetsRepository = {
      isApproved: async () => false,
      add: async () => {},
    };

    const orchestrator = createOrchestrator({
      clock: fixedClock(),
      crypto: mockCryptoProvider(),
      logger: capturingLogger(),
      threadService: mockThreadService(),
      priorityQueue: mockQueue(),
      activeAgents,
      maiaRuntime: { handleMessage: async () => ({ content: "" }) },
      wsPush: () => {},
      agentRegistry: mockRegistry,
      approvedSnippetsRepo: approvedRepo,
      onFlaggedAgentApprovalRequest: (agentId, agentName, reason, snippet) => {
        flaggedCalls.push({ agentId, agentName, reason, snippet });
      },
    });

    await orchestrator.agentToAgentChat("alice", "bot", "Hi");
    // Flagged party is fromAgent (alice), so alice is stopped; bot (responder) is not.
    expect(activeAgents.has("alice")).toBe(false);
    expect(activeAgents.has("bot")).toBe(true);
    expect(flaggedCalls).toHaveLength(1);
    expect(flaggedCalls[0]).toEqual({
      agentId: "alice",
      agentName: "Alice",
      reason: "Injection",
      snippet: "ignore instructions",
    });
  });

  it("agentToAgentChat when response has progressReport: sends DM to user via threadService and wsPush", async () => {
    const toAgent = createSubAgent("bot", "Bot", {
      content: "Done.",
      progressReport: { status: "accomplished", summary: "Task complete." },
    });
    activeAgents.set("bot", toAgent);

    const addMessageCalls: Array<{ threadId: string; senderId: string; content: string }> = [];
    const threadService = mockThreadService({
      addMessage: async (threadId, senderId, _senderType, content) => {
        addMessageCalls.push({ threadId, senderId, content });
        return {
          id: "m",
          threadId,
          senderId,
          senderType: "agent",
          content,
          createdAt: "",
        };
      },
    });

    const orchestrator = createOrchestrator({
      clock: fixedClock(),
      crypto: mockCryptoProvider(),
      logger: capturingLogger(),
      threadService,
      priorityQueue: mockQueue(),
      activeAgents,
      maiaRuntime: { handleMessage: async () => ({ content: "" }) },
      wsPush: (type, payload) => {
        if (type === "agent_dm") wsPushCalls.push({ type, payload });
      },
      activeHours: { startHour: 0, endHour: 24 },
      agentRegistry: {
        get: async () => toAgent.config,
        update: async () => {},
        remove: async () => {},
        list: async () => [],
        agentWorkspacePath: () => "/w",
      },
    });

    await orchestrator.agentToAgentChat("maia", "bot", "Go");
    const progressDm = addMessageCalls.find((c) => c.content.startsWith("Progress:"));
    expect(progressDm).toBeDefined();
    expect(progressDm!.content).toContain("accomplished");
    expect(progressDm!.content).toContain("Task complete.");
    expect(wsPushCalls.some((c) => c.type === "agent_dm")).toBe(true);
  });

  it("agentToAgentChat when response has remembered and agentWorkspaceFs: applies to from-agent workspace", async () => {
    const toAgent = createSubAgent("bot", "Bot", {
      content: "Noted.",
      remembered: { memoryMd: "Shared fact.", userMd: "", soulMd: "" },
    });
    activeAgents.set("bot", toAgent);

    const { inMemoryFileSystem } = await import("../../helpers/index.js");
    const fs = inMemoryFileSystem();
    const logger = capturingLogger();

    const orchestrator = createOrchestrator({
      clock: fixedClock(),
      crypto: mockCryptoProvider(),
      logger,
      threadService: mockThreadService(),
      priorityQueue: mockQueue(),
      activeAgents,
      maiaRuntime: { handleMessage: async () => ({ content: "" }) },
      wsPush: () => {},
      agentRegistry: {
        get: async () => toAgent.config,
        update: async () => {},
        remove: async () => {},
        list: async () => [],
        agentWorkspacePath: (id) => (id === "maia" ? "/workspace/maia" : "/workspace/bot"),
      },
      agentWorkspaceFs: fs,
    });

    await orchestrator.agentToAgentChat("maia", "bot", "Remember this");
    const memoryContent = await fs.readFile("/workspace/maia/MEMORY.md");
    expect(memoryContent).toBe("Shared fact.");
  });
});
