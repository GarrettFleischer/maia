/**
 * @fileoverview Unit tests for LLM provider interface, health monitoring, fallback, and request queue.
 * @module tests/unit/providers/provider
 */

import { describe, it, expect } from "bun:test";
import { createProviderRegistry } from "../../../src/providers/base.js";
import { createTestContext } from "../../helpers/index.js";
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

// Request queue is tested in tests/unit/providers/queue.test.ts (sync queue with claimNext/remove/release).
