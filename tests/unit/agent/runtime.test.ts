/**
 * @fileoverview Unit tests for the agent runtime message pipeline.
 * @module tests/unit/agent/runtime
 */

import { describe, it, expect } from "bun:test";
import { createAgentRuntime } from "../../../src/agent/runtime.js";
import { createSessionManager } from "../../../src/agent/session.js";
import { createContextBuilder } from "../../../src/agent/context.js";
import { createToolRegistry } from "../../../src/agent/tools/registry.js";
import {
  capturingLogger,
  mockEventBus,
  inMemoryFileSystem,
  testConfig,
  fixedClock,
} from "../../helpers/index.js";
import type { ChatChunk, LLMProvider, InboundMessage, ToolCall } from "../../../src/core/types.js";
import { createMemorySearchTool } from "../../../src/agent/tools/memory-tools.js";
import { mockCryptoProvider } from "../../helpers/index.js";
import { createMemoryStore } from "../../../src/memory/store.js";
import * as path from "node:path";
import * as fsNative from "node:fs/promises";
import { createSQLiteDatabase } from "../../../src/adapters/database.js";

/**
 * @brief Creates a mock LLM provider that returns a fixed response.
 * @param response - The content the mock provider should return
 * @returns LLMProvider that yields a single chunk with the given content
 */
function mockProvider(response: string): LLMProvider {
  return {
    id: "mock",
    name: "Mock Provider",
    async *chat(): AsyncGenerator<ChatChunk> {
      yield { content: response, done: true };
    },
    async healthCheck() { return true; },
    async listModels() { return []; },
    contextWindowSize() { return 4096; },
  };
}

/**
 * @brief Creates a test inbound message.
 */
function testMessage(content: string): InboundMessage {
  return {
    id: "msg-1",
    channelId: "cli",
    senderId: "user",
    content,
    timestamp: "2026-02-13T12:00:00.000Z",
    isGroup: false,
  };
}

describe("AgentRuntime", () => {
  function setup(providerResponse = "Hello, I'm Maia!") {
    const logger = capturingLogger();
    const events = mockEventBus();
    const config = testConfig();
    const fs = inMemoryFileSystem({
      "/test/workspace/SOUL.md": "# Soul\nYou are a test assistant.",
      "/test/workspace/IDENTITY.md": "# Identity\nname: TestMaia",
    });
    const clock = fixedClock();
    const provider = mockProvider(providerResponse);

    const sessionManager = createSessionManager({
      contextWindowSize: 4096,
      compactionThresholdPercent: 80,
      preserveRecentMessages: 10,
      logger,
      clock,
    });

    const contextBuilder = createContextBuilder({ fs, config, logger });
    const toolRegistry = createToolRegistry({ logger });

    const sentReplies: Array<{ channelId: string; content: string }> = [];

    const runtime = createAgentRuntime({
      config,
      logger,
      events,
      provider,
      sessionManager,
      contextBuilder,
      toolRegistry,
      sendReply: async (msg) => {
        sentReplies.push({ channelId: msg.channelId, content: msg.content });
      },
    });

    return { runtime, logger, events, sentReplies, sessionManager };
  }

  // ── Basic message handling ───────────────────────────────────────

  it("should return the LLM response content", async () => {
    const { runtime } = setup("Hello from the LLM!");
    const response = await runtime.handleMessage(testMessage("Hi there"));
    expect(response).toBe("Hello from the LLM!");
  });

  it("should call sendReply with the response", async () => {
    const { runtime, sentReplies } = setup("Reply content");
    await runtime.handleMessage(testMessage("Test"));

    expect(sentReplies).toHaveLength(1);
    expect(sentReplies[0].content).toBe("Reply content");
    expect(sentReplies[0].channelId).toBe("cli");
  });

  // ── Session management ───────────────────────────────────────────

  it("should create a session for new channel+sender pair", async () => {
    const { runtime } = setup();
    await runtime.handleMessage(testMessage("First message"));

    const sessionId = runtime.getSessionId("cli", "user");
    expect(sessionId).toBeTruthy();
  });

  it("should reuse session for same channel+sender", async () => {
    const { runtime } = setup();
    await runtime.handleMessage(testMessage("First"));
    const id1 = runtime.getSessionId("cli", "user");

    await runtime.handleMessage(testMessage("Second"));
    const id2 = runtime.getSessionId("cli", "user");

    expect(id1).toBe(id2);
  });

  it("should create separate sessions for different senders", async () => {
    const { runtime } = setup();
    await runtime.handleMessage({
      ...testMessage("From Alice"),
      senderId: "alice",
    });
    await runtime.handleMessage({
      ...testMessage("From Bob"),
      senderId: "bob",
    });

    const aliceSession = runtime.getSessionId("cli", "alice");
    const bobSession = runtime.getSessionId("cli", "bob");
    expect(aliceSession).not.toBe(bobSession);
  });

  // ── Event emission ───────────────────────────────────────────────

  it("should emit messageReceived and messageSent events", async () => {
    const { runtime, events } = setup();
    await runtime.handleMessage(testMessage("Hi"));

    const received = events.emittedEvents.filter((e) => e.event === "messageReceived");
    const sent = events.emittedEvents.filter((e) => e.event === "messageSent");

    expect(received).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  // ── Memory recall integration ────────────────────────────────────

  it("should call recallMemory when provided", async () => {
    const logger = capturingLogger();
    const events = mockEventBus();
    const config = testConfig();
    const fs = inMemoryFileSystem();
    const clock = fixedClock();

    let recallQuery = "";
    const runtime = createAgentRuntime({
      config,
      logger,
      events,
      provider: mockProvider("With memory!"),
      sessionManager: createSessionManager({
        contextWindowSize: 4096,
        compactionThresholdPercent: 80,
        preserveRecentMessages: 10,
        logger,
        clock,
      }),
      contextBuilder: createContextBuilder({ fs, config, logger }),
      toolRegistry: createToolRegistry({ logger }),
      recallMemory: async (query) => {
        recallQuery = query;
        return "User likes TypeScript";
      },
      sendReply: async () => {},
    });

    await runtime.handleMessage(testMessage("What do I like?"));
    expect(recallQuery).toBe("What do I like?");
  });

  // ── Privacy mode ─────────────────────────────────────────────────

  it("should execute tool calls and then send final reply", async () => {
    const db = createSQLiteDatabase(":memory:");
    const sqlPath = path.resolve("src/core/migrations/migrations/001_initial_schema.sql");
    const sql = await fsNative.readFile(sqlPath, "utf-8");
    await db.execute(sql);
    const logger = capturingLogger();
    const crypto = mockCryptoProvider();
    const store = createMemoryStore({ db, crypto, logger });
    const toolRegistry = createToolRegistry({ logger });
    toolRegistry.register(createMemorySearchTool({ store, logger }));

    let callCount = 0;
    async function* providerWithToolCall(): AsyncGenerator<ChatChunk> {
      callCount++;
      if (callCount === 1) {
        yield {
          content: "",
          done: true,
          toolCalls: [
            {
              id: "tc-1",
              name: "memory_search",
              arguments: { query: "test" },
            } as ToolCall,
          ],
        };
      } else {
        yield { content: "I searched memory and found nothing.", done: true };
      }
    }

    const sentReplies: Array<{ channelId: string; content: string }> = [];
    const runtime = createAgentRuntime({
      config: testConfig(),
      logger,
      events: mockEventBus(),
      provider: {
        id: "mock",
        name: "Mock",
        chat: providerWithToolCall,
        healthCheck: async () => true,
        listModels: async () => [],
        contextWindowSize: () => 4096,
      },
      sessionManager: createSessionManager({
        contextWindowSize: 4096,
        compactionThresholdPercent: 80,
        preserveRecentMessages: 10,
        logger,
        clock: fixedClock(),
      }),
      contextBuilder: createContextBuilder({
        fs: inMemoryFileSystem({ "/test/workspace/SOUL.md": "# Soul" }),
        config: testConfig(),
        logger,
      }),
      toolRegistry,
      sendReply: async (msg) => {
        sentReplies.push({ channelId: msg.channelId, content: msg.content });
      },
    });

    const response = await runtime.handleMessage(testMessage("Search memory for test"));
    expect(callCount).toBe(2);
    expect(response).toContain("I searched memory");
    expect(sentReplies.length).toBeGreaterThanOrEqual(1);
  });

  it("should skip memory recall when privacy is active", async () => {
    const logger = capturingLogger();
    const events = mockEventBus();
    const config = testConfig();
    const fs = inMemoryFileSystem();
    const clock = fixedClock();

    let memoryCalled = false;
    const runtime = createAgentRuntime({
      config,
      logger,
      events,
      provider: mockProvider("Private response"),
      sessionManager: createSessionManager({
        contextWindowSize: 4096,
        compactionThresholdPercent: 80,
        preserveRecentMessages: 10,
        logger,
        clock,
      }),
      contextBuilder: createContextBuilder({ fs, config, logger }),
      toolRegistry: createToolRegistry({ logger }),
      recallMemory: async () => {
        memoryCalled = true;
        return "";
      },
      isPrivacyActive: () => true,
      sendReply: async () => {},
    });

    await runtime.handleMessage(testMessage("Private question"));
    expect(memoryCalled).toBe(false);
  });
});
