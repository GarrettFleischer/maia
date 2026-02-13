/**
 * @fileoverview Unit tests for LLM provider interface, health monitoring, fallback, and request queue.
 * @module tests/unit/providers/provider
 */

import { describe, it, expect } from "bun:test";
import { createProviderRegistry } from "../../../src/providers/base.js";
import { createRequestQueue } from "../../../src/providers/queue.js";
import { createTestContext, fixedClock } from "../../helpers/index.js";
import type { LLMProvider, ChatMessage, ChatChunk } from "../../../src/core/types.js";

/**
 * @brief Creates a mock LLM provider for testing.
 */
function createMockProvider(id: string, options?: {
  healthy?: boolean;
  contextWindow?: number;
}): LLMProvider {
  const healthy = options?.healthy ?? true;
  const contextWindow = options?.contextWindow ?? 4096;

  return {
    id,
    name: `Mock ${id}`,
    async *chat(_messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      yield { content: `Response from ${id}`, done: true };
    },
    async listModels() {
      return [{ id: "test-model", name: "Test Model", contextWindow }];
    },
    async healthCheck() {
      return healthy;
    },
    contextWindowSize() {
      return contextWindow;
    },
  };
}

describe("Provider Registry", () => {
  it("should register and retrieve a provider", () => {
    const ctx = createTestContext();
    const registry = createProviderRegistry(ctx);
    const provider = createMockProvider("ollama");

    registry.register(provider);
    expect(registry.get("ollama")).toBe(provider);
  });

  it("should throw when getting an unregistered provider", () => {
    const ctx = createTestContext();
    const registry = createProviderRegistry(ctx);

    expect(() => registry.get("nonexistent")).toThrow();
  });

  it("should return the primary provider", () => {
    const ctx = createTestContext();
    const registry = createProviderRegistry(ctx);
    registry.register(createMockProvider("ollama"));

    const primary = registry.getPrimary();
    expect(primary.id).toBe("ollama");
  });

  it("should fall back to secondary provider on failure", async () => {
    const ctx = createTestContext();
    const registry = createProviderRegistry(ctx);
    registry.register(createMockProvider("ollama", { healthy: false }));
    registry.register(createMockProvider("groq", { healthy: true }));

    const provider = await registry.getHealthy();
    expect(provider.id).toBe("groq");
  });

  it("should report health status for all providers", async () => {
    const ctx = createTestContext();
    const registry = createProviderRegistry(ctx);
    registry.register(createMockProvider("ollama", { healthy: true }));
    registry.register(createMockProvider("groq", { healthy: false }));

    const status = await registry.healthStatus();
    expect(status.get("ollama")).toBe(true);
    expect(status.get("groq")).toBe(false);
  });

  it("should report context window size for active model", () => {
    const ctx = createTestContext();
    const registry = createProviderRegistry(ctx);
    registry.register(createMockProvider("ollama", { contextWindow: 8192 }));

    const size = registry.get("ollama").contextWindowSize("test-model");
    expect(size).toBe(8192);
  });
});

describe("Request Queue", () => {
  it("should process requests in FIFO order", async () => {
    const results: number[] = [];
    const queue = createRequestQueue({
      maxConcurrent: 1,
      maxQueueDepth: 10,
      clock: fixedClock(),
    });

    await Promise.all([
      queue.enqueue(async () => { results.push(1); }),
      queue.enqueue(async () => { results.push(2); }),
      queue.enqueue(async () => { results.push(3); }),
    ]);

    expect(results).toEqual([1, 2, 3]);
  });

  it("should reject when queue is full", async () => {
    const queue = createRequestQueue({
      maxConcurrent: 1,
      maxQueueDepth: 1,
      clock: fixedClock(),
    });

    // Fill the queue
    const slow = queue.enqueue(() => new Promise((r) => setTimeout(r, 100)));
    const queued = queue.enqueue(() => Promise.resolve());

    // This should be rejected
    await expect(queue.enqueue(() => Promise.resolve())).rejects.toThrow();

    await slow;
    await queued;
  });

  it("should report queue depth", async () => {
    const queue = createRequestQueue({
      maxConcurrent: 1,
      maxQueueDepth: 10,
      clock: fixedClock(),
    });

    expect(queue.depth()).toBe(0);
  });
});
