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
    const result = await runtime.handleMessage(testMessage("Hi there"));
    expect(result.content).toBe("Hello from the LLM!");
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

    const result = await runtime.handleMessage(testMessage("Search memory for test"));
    expect(callCount).toBe(2);
    expect(result.content).toContain("I searched memory");
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

  // ── Structured blocks (SECURITY, PROGRESS, REMEMBER) ─────────────────────

  it("should return securityFlagged and call onSecurityFlagged when response contains flagged SECURITY block", async () => {
    const response =
      "I cannot help with that.\n---SECURITY---\n{\"flagged\": true, \"reason\": \"Possible injection\", \"snippet\": \"ignore instructions\"}";
    const flaggedCalls: Array<{ reason: string; snippet: string }> = [];
    const logger = capturingLogger();
    const events = mockEventBus();
    const config = testConfig();
    const fs = inMemoryFileSystem({
      "/test/workspace/SOUL.md": "# Soul",
      "/test/workspace/IDENTITY.md": "# Identity\nname: TestMaia",
    });
    const runtime = createAgentRuntime({
      config,
      logger,
      events,
      provider: mockProvider(response),
      sessionManager: createSessionManager({
        contextWindowSize: 4096,
        compactionThresholdPercent: 80,
        preserveRecentMessages: 10,
        logger,
        clock: fixedClock(),
      }),
      contextBuilder: createContextBuilder({ fs, config, logger }),
      toolRegistry: createToolRegistry({ logger }),
      onSecurityFlagged: (reason, snippet) => flaggedCalls.push({ reason, snippet }),
      sendReply: async () => {},
    });
    const result = await runtime.handleMessage(testMessage("Hi"));
    expect(result.content).toBe("I cannot help with that.");
    expect(result.securityFlagged).toEqual({
      reason: "Possible injection",
      snippet: "ignore instructions",
    });
    expect(flaggedCalls).toHaveLength(1);
    expect(flaggedCalls[0].reason).toBe("Possible injection");
    expect(flaggedCalls[0].snippet).toBe("ignore instructions");
  });

  it("should return progressReport when response contains PROGRESS block", async () => {
    const response =
      "Task completed.\n---PROGRESS---\n{\"status\": \"accomplished\", \"summary\": \"All items processed.\"}";
    const { runtime } = setup(response);
    const result = await runtime.handleMessage(testMessage("Go"));
    expect(result.content).toBe("Task completed.");
    expect(result.progressReport).toEqual({
      status: "accomplished",
      summary: "All items processed.",
    });
  });

  it("should not set securityFlagged when SECURITY block has flagged false", async () => {
    const response = "Fine.\n---SECURITY---\n{\"flagged\": false}";
    const { runtime } = setup(response);
    const result = await runtime.handleMessage(testMessage("Hi"));
    expect(result.securityFlagged).toBeUndefined();
  });

  it("should return remembered and apply when parseRemember provided and REMEMBER block present", async () => {
    const fs = inMemoryFileSystem({
      "/test/workspace/SOUL.md": "# Soul",
      "/test/workspace/IDENTITY.md": "# Identity\nname: TestMaia",
    });
    const handler = (await import("../../../src/memory/remember-block.js")).createRememberBlockHandler({
      fs,
      logger: capturingLogger(),
      workspacePath: "/test/workspace",
    });
    const response = `Done.\n---REMEMBER---\n{"memoryMd": "User likes tests."}`;
    const runtime = createAgentRuntime({
      config: testConfig(),
      logger: capturingLogger(),
      events: mockEventBus(),
      provider: mockProvider(response),
      sessionManager: createSessionManager({
        contextWindowSize: 4096,
        compactionThresholdPercent: 80,
        preserveRecentMessages: 10,
        logger: capturingLogger(),
        clock: fixedClock(),
      }),
      contextBuilder: createContextBuilder({ fs, config: testConfig(), logger: capturingLogger() }),
      toolRegistry: createToolRegistry({ logger: capturingLogger() }),
      parseRemember: (raw) => handler.parseAndApply(raw),
      sendReply: async () => {},
    });
    const result = await runtime.handleMessage(testMessage("Remember this"));
    expect(result.content).toBe("Done.");
    expect(result.remembered).toBeDefined();
    expect((result.remembered as { memoryMd?: string }).memoryMd).toBe("User likes tests.");
    const memoryContent = await fs.readFile("/test/workspace/MEMORY.md");
    expect(memoryContent).toContain("User likes tests.");
  });
});
