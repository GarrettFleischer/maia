/**
 * @fileoverview Unit tests for onAfterReply callback in agent runtime.
 * @module tests/unit/agent/runtime-afterreply
 */

import { describe, it, expect } from "bun:test";
import { createAgentRuntime } from "../../../src/agent/runtime.js";
import type { AgentRuntimeDeps } from "../../../src/agent/runtime.js";
import type {
  InboundMessage,
  LLMProvider,
  ChatChunk,
  ChatMessage,
} from "../../../src/core/types.js";
import type { ContextBuilder } from "../../../src/agent/context.js";
import type { SessionManager } from "../../../src/agent/session.js";
import type { ToolRegistry } from "../../../src/agent/tools/registry.js";
import {
  capturingLogger,
  mockEventBus,
  testConfig,
} from "../../helpers/index.js";

// ─── Helpers ─────────────────────────────────────────────────────

function mockLLMProvider(responseText?: string): LLMProvider {
  return {
    id: "mock",
    name: "MockLLM",
    async *chat(): AsyncGenerator<ChatChunk> {
      yield { content: responseText ?? "Test response", done: true };
    },
    async listModels() { return []; },
    async healthCheck() { return true; },
    contextWindowSize() { return 4096; },
  };
}

function mockSessionManager(): SessionManager {
  let messageCounter = 0;
  const messages: ChatMessage[] = [];
  return {
    create() { return { id: `session-${++messageCounter}`, messages: [], createdAt: new Date().toISOString() }; },
    addMessage(_sessionId: string, message: ChatMessage) { messages.push(message); },
    getMessages() { return [...messages]; },
    needsCompaction() { return false; },
    compact: async () => {},
    getSession: () => undefined,
  } as unknown as SessionManager;
}

function mockContextBuilder(): ContextBuilder {
  return {
    async buildSystemPrompt() {
      return { role: "system", content: "You are helpful." };
    },
    async loadWorkspaceFile() { return ""; },
  };
}

function mockToolRegistry(): ToolRegistry {
  return {
    register: () => {},
    get: () => undefined,
    definitions: () => [],
    execute: async () => ({ content: "", success: true }),
    list: () => [],
  } as unknown as ToolRegistry;
}

function makeMessage(content?: string): InboundMessage {
  return {
    id: "msg-1",
    channelId: "cli",
    senderId: "user-1",
    content: content ?? "Hello",
    timestamp: new Date().toISOString(),
    isGroup: false,
  };
}

function makeRuntime(overrides?: Partial<AgentRuntimeDeps>) {
  const logger = capturingLogger();
  const events = mockEventBus();
  const deps: AgentRuntimeDeps = {
    config: testConfig(),
    logger,
    events,
    provider: mockLLMProvider(),
    sessionManager: mockSessionManager(),
    contextBuilder: mockContextBuilder(),
    toolRegistry: mockToolRegistry(),
    sendReply: async () => {},
    ...overrides,
  };
  const runtime = createAgentRuntime(deps);
  return { runtime, logger, events };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("AgentRuntime onAfterReply", () => {
  it("should call onAfterReply with correct params after reply", async () => {
    let capturedParams: Record<string, unknown> | null = null;
    const { runtime } = makeRuntime({
      onAfterReply: async (params) => {
        capturedParams = params as unknown as Record<string, unknown>;
      },
    });

    await runtime.handleMessage(makeMessage("What is TypeScript?"));

    // Give the fire-and-forget callback a tick to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.userContent).toBe("What is TypeScript?");
    expect(capturedParams!.responseContent).toBe("Test response");
    expect(typeof capturedParams!.sessionId).toBe("string");
    expect(capturedParams!.privacyMode).toBe(false);
  });

  it("should return reply before onAfterReply resolves", async () => {
    let callbackResolved = false;
    const { runtime } = makeRuntime({
      onAfterReply: async () => {
        await new Promise((r) => setTimeout(r, 200));
        callbackResolved = true;
      },
    });

    const result = await runtime.handleMessage(makeMessage());

    // Reply should be returned before the callback finishes
    expect(result.content).toBe("Test response");
    expect(callbackResolved).toBe(false);

    // Clean up - wait for callback
    await new Promise((r) => setTimeout(r, 250));
  });

  it("should log warning when onAfterReply throws", async () => {
    const { runtime, logger } = makeRuntime({
      onAfterReply: async () => {
        throw new Error("Callback explosion");
      },
    });

    await runtime.handleMessage(makeMessage());
    await new Promise((r) => setTimeout(r, 50));

    expect(logger.calls.some(
      (c) => c.level === "warn" && c.message === "onAfterReply failed"
    )).toBe(true);
  });

  it("should not error when onAfterReply is not provided", async () => {
    const { runtime } = makeRuntime({ onAfterReply: undefined });

    const result = await runtime.handleMessage(makeMessage());
    expect(result.content).toBe("Test response");
  });

  it("should pass privacyMode=true when privacy is active", async () => {
    let capturedPrivacy: boolean | undefined;
    const { runtime } = makeRuntime({
      isPrivacyActive: () => true,
      onAfterReply: async (params) => {
        capturedPrivacy = params.privacyMode;
      },
    });

    await runtime.handleMessage(makeMessage());
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedPrivacy).toBe(true);
  });

  it("should still return response even if onAfterReply throws", async () => {
    const { runtime } = makeRuntime({
      onAfterReply: async () => {
        throw new Error("Boom");
      },
    });

    const result = await runtime.handleMessage(makeMessage());
    expect(result.content).toBe("Test response");
  });
});
