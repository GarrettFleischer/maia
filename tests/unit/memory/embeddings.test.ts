/**
 * @fileoverview Unit tests for embedding provider (fallback and provider paths).
 * @module tests/unit/memory/embeddings
 */

import { describe, it, expect } from "bun:test";
import { createEmbeddingProvider } from "../../../src/memory/embeddings.js";
import { capturingLogger } from "../../helpers/index.js";

describe("EmbeddingProvider", () => {
  it("should use fallback when no provider given", async () => {
    const logger = capturingLogger();
    const provider = createEmbeddingProvider({ logger });
    const vectors = await provider.embed(["hello", "world"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(64);
    expect(vectors[1]).toHaveLength(64);
  });

  it("should produce normalized vectors (L2 norm ~1) for non-empty text", async () => {
    const logger = capturingLogger();
    const provider = createEmbeddingProvider({ logger });
    const vectors = await provider.embed(["test text"]);
    const magnitude = Math.sqrt(vectors[0].reduce((s, v) => s + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it("should use provider embed when available", async () => {
    const logger = capturingLogger();
    const customVec = [0.1, 0.2, 0.3];
    const mockProvider = {
      id: "mock",
      name: "Mock",
      chat: async function* () { yield { content: "", done: true }; },
      listModels: async () => [],
      healthCheck: async () => true,
      contextWindowSize: () => 4096,
      embed: async (texts: string[]) => texts.map(() => [...customVec]),
    };
    const provider = createEmbeddingProvider({ provider: mockProvider, logger });
    const vectors = await provider.embed(["a"]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toEqual(customVec);
  });

  it("should fall back to character embedding when provider embed throws", async () => {
    const logger = capturingLogger();
    const mockProvider = {
      id: "mock",
      name: "Mock",
      chat: async function* () { yield { content: "", done: true }; },
      listModels: async () => [],
      healthCheck: async () => true,
      contextWindowSize: () => 4096,
      embed: async () => {
        throw new Error("embed failed");
      },
    };
    const provider = createEmbeddingProvider({ provider: mockProvider, logger });
    const vectors = await provider.embed(["hello"]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(64);
  });
});
