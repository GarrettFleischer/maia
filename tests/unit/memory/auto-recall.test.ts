/**
 * @fileoverview Unit tests for auto-recall (context injection before agent starts).
 * @module tests/unit/memory/auto-recall
 */

import { describe, it, expect } from "bun:test";
import { createAutoRecall } from "../../../src/memory/auto-recall.js";
import { capturingLogger } from "../../helpers/index.js";
import type { MemoryStore, MemorySearchResult, MemoryEntry } from "../../../src/core/types.js";

/**
 * @brief Creates a mock memory store with preset search results.
 */
function mockMemoryStore(results: MemorySearchResult[]): MemoryStore {
  return {
    async store(entry) {
      return { ...entry, id: "test", createdAt: "", updatedAt: "" } as MemoryEntry;
    },
    async search() {
      return results;
    },
    async get() { return null; },
    async remove() {},
    async count() { return results.length; },
  };
}

describe("Auto-Recall", () => {
  it("should return relevant memories for a query", async () => {
    const store = mockMemoryStore([
      {
        entry: {
          id: "1",
          text: "User prefers dark mode",
          category: "preference",
          importance: 0.9,
          createdAt: "2026-02-13",
          updatedAt: "2026-02-13",
        },
        score: 0.85,
      },
    ]);
    const logger = capturingLogger();
    const recall = createAutoRecall({ store, logger, limit: 5 });

    const memories = await recall.recall("What are my preferences?");
    expect(memories).toHaveLength(1);
    expect(memories[0].entry.text).toContain("dark mode");
  });

  it("should format memories as a context block", async () => {
    const store = mockMemoryStore([
      {
        entry: {
          id: "1",
          text: "User likes TypeScript",
          category: "preference",
          importance: 0.8,
          createdAt: "2026-02-10",
          updatedAt: "2026-02-10",
        },
        score: 0.9,
      },
    ]);
    const logger = capturingLogger();
    const recall = createAutoRecall({ store, logger, limit: 5 });

    const block = await recall.formatContextBlock("Tell me about TypeScript");
    expect(block).toContain("relevant-memories");
    expect(block).toContain("TypeScript");
  });

  it("should return empty block when no memories found", async () => {
    const store = mockMemoryStore([]);
    const logger = capturingLogger();
    const recall = createAutoRecall({ store, logger, limit: 5 });

    const block = await recall.formatContextBlock("Something random");
    expect(block).toBe("");
  });

  it("should respect the limit parameter", async () => {
    const manyResults: MemorySearchResult[] = Array.from({ length: 10 }, (_, i) => ({
      entry: {
        id: `${i}`,
        text: `Memory ${i}`,
        category: "fact" as const,
        importance: 0.5,
        createdAt: "2026-02-13",
        updatedAt: "2026-02-13",
      },
      score: 0.5,
    }));
    const store = mockMemoryStore(manyResults);
    const logger = capturingLogger();
    const recall = createAutoRecall({ store, logger, limit: 3 });

    const memories = await recall.recall("test");
    expect(memories.length).toBeLessThanOrEqual(3);
  });
});
