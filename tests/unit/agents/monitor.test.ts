/**
 * @fileoverview Unit tests for LLM request/response monitoring proxy.
 * @module tests/unit/agents/monitor
 */

import { describe, it, expect } from "bun:test";
import { createMonitoredProvider } from "../../../src/agents/monitor.js";
import type { MonitorCallbacks } from "../../../src/agents/monitor.js";
import type { LLMProvider, ChatMessage, ChatChunk } from "../../../src/core/types.js";
import { capturingLogger, mockEventBus } from "../../helpers/index.js";

/**
 * @brief Creates a mock LLM provider that yields predictable chunks.
 */
function mockProvider(chunks?: ChatChunk[]): LLMProvider {
  const defaultChunks: ChatChunk[] = [
    { content: "Hello ", done: false },
    { content: "world!", done: true },
  ];
  return {
    id: "test-provider",
    name: "TestProvider",
    async *chat(): AsyncGenerator<ChatChunk> {
      for (const chunk of (chunks ?? defaultChunks)) {
        yield chunk;
      }
    },
    async listModels() {
      return [{ id: "test-model", name: "Test", provider: "test", contextWindow: 4096 }];
    },
    async healthCheck() { return true; },
    contextWindowSize() { return 4096; },
  };
}

function makeMonitored(opts?: { provider?: LLMProvider; callbacks?: MonitorCallbacks }) {
  const logger = capturingLogger();
  const events = mockEventBus();
  const provider = opts?.provider ?? mockProvider();
  const monitored = createMonitoredProvider({
    provider,
    agentId: "test-agent",
    logger,
    events,
    callbacks: opts?.callbacks,
  });
  return { monitored, logger, events, provider };
}

describe("MonitoredProvider", () => {
  it("should proxy chat stream and yield all chunks", async () => {
    const { monitored } = makeMonitored();
    const messages: ChatMessage[] = [{ role: "user", content: "Hi" }];

    let fullContent = "";
    for await (const chunk of monitored.chat(messages)) {
      fullContent += chunk.content;
    }

    expect(fullContent).toBe("Hello world!");
  });

  it("should log request with agentId and message count", async () => {
    const { monitored, logger } = makeMonitored();
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What is 2+2?" },
    ];

    // Consume stream
    for await (const _ of monitored.chat(messages)) { /* drain */ }

    const requestLog = logger.calls.find((c) => c.message === "Agent LLM request");
    expect(requestLog).toBeDefined();
    expect(requestLog!.meta!.agentId).toBe("test-agent");
    expect(requestLog!.meta!.messageCount).toBe(2);
  });

  it("should log response with duration and response length", async () => {
    const { monitored, logger } = makeMonitored();
    const messages: ChatMessage[] = [{ role: "user", content: "Hi" }];

    for await (const _ of monitored.chat(messages)) { /* drain */ }

    const responseLog = logger.calls.find((c) => c.message === "Agent LLM response");
    expect(responseLog).toBeDefined();
    expect(responseLog!.meta!.responseLength).toBe(12); // "Hello world!" length
    expect(responseLog!.meta!.toolCalls).toBe(0);
    expect(typeof responseLog!.meta!.durationMs).toBe("number");
  });

  it("should count tool calls in stream", async () => {
    const provider = mockProvider([
      { content: "Using tool.", done: false, toolCalls: [{ id: "t1", name: "web_fetch", arguments: {} }] },
      { content: " Done.", done: true },
    ]);
    const { monitored, logger } = makeMonitored({ provider });

    for await (const _ of monitored.chat([])) { /* drain */ }

    const responseLog = logger.calls.find((c) => c.message === "Agent LLM response");
    expect(responseLog!.meta!.toolCalls).toBe(1);
  });

  it("should call onRequest callback", async () => {
    let capturedRequest: Record<string, unknown> | null = null;
    const callbacks: MonitorCallbacks = {
      onRequest: (params) => { capturedRequest = params as unknown as Record<string, unknown>; },
    };
    const { monitored } = makeMonitored({ callbacks });
    const messages: ChatMessage[] = [{ role: "user", content: "Test" }];

    for await (const _ of monitored.chat(messages)) { /* drain */ }

    expect(capturedRequest).toBeDefined();
    const req = capturedRequest as unknown as Record<string, unknown>;
    expect(req.agentId).toBe("test-agent");
  });

  it("should call onResponse callback with content and duration", async () => {
    let capturedResponse: Record<string, unknown> | null = null;
    const callbacks: MonitorCallbacks = {
      onResponse: (params) => {
        capturedResponse = params as unknown as Record<string, unknown>;
      },
    };
    const { monitored } = makeMonitored({ callbacks });

    for await (const _ of monitored.chat([])) { /* drain */ }

    expect(capturedResponse).toBeDefined();
    const res = capturedResponse as unknown as Record<string, unknown>;
    expect(res.content).toBe("Hello world!");
    expect(typeof res.durationMs).toBe("number");
  });

  it("should emit agentResponse event", async () => {
    const { monitored, events } = makeMonitored();

    for await (const _ of monitored.chat([])) { /* drain */ }

    const evt = events.emittedEvents.find((e) => e.event === "agentResponse");
    expect(evt).toBeDefined();
    expect(evt!.data.agentId).toBe("test-agent");
    expect(evt!.data.responseLength).toBe(12);
  });

  it("should return correct name", () => {
    const { monitored } = makeMonitored();
    expect(monitored.name).toBe("monitored:test-agent:TestProvider");
  });

  it("should delegate listModels and healthCheck", async () => {
    const { monitored } = makeMonitored();
    const models = await monitored.listModels();
    expect(models).toHaveLength(1);

    const healthy = await monitored.healthCheck();
    expect(healthy).toBe(true);
  });

  it("should not crash when callbacks are omitted", async () => {
    const { monitored } = makeMonitored({ callbacks: undefined });

    let content = "";
    for await (const chunk of monitored.chat([])) {
      content += chunk.content;
    }
    expect(content).toBe("Hello world!");
  });
});
