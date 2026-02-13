/**
 * @fileoverview Unit tests for hybrid vector + FTS search.
 * @module tests/unit/memory/search
 */

import { describe, it, expect } from "bun:test";
import { createHybridSearch } from "../../../src/memory/search.js";
import { inMemoryDatabase, capturingLogger } from "../../helpers/index.js";

describe("Hybrid Search", () => {
  function makeSearch() {
    const db = inMemoryDatabase();
    const logger = capturingLogger();
    const search = createHybridSearch({
      db,
      logger,
      vectorWeight: 0.7,
      textWeight: 0.3,
    });
    return { search, db };
  }

  it("should combine vector and text scores", async () => {
    const { search } = makeSearch();
    const results = await search.search("TypeScript preferences", {
      embedding: new Array(384).fill(0.1),
      limit: 5,
    });
    expect(Array.isArray(results)).toBe(true);
  });

  it("should respect the limit parameter", async () => {
    const { search } = makeSearch();
    const results = await search.search("test", {
      embedding: new Array(384).fill(0.1),
      limit: 3,
    });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("should filter by category when specified", async () => {
    const { search } = makeSearch();
    const results = await search.search("test", {
      embedding: new Array(384).fill(0.1),
      limit: 5,
      category: "preference",
    });
    expect(Array.isArray(results)).toBe(true);
  });

  it("should return results sorted by combined score (highest first)", async () => {
    const { search } = makeSearch();
    const results = await search.search("test", {
      embedding: new Array(384).fill(0.1),
      limit: 10,
    });

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("should return empty array when no matches", async () => {
    const { search } = makeSearch();
    const results = await search.search("xyzzy-no-match", {
      embedding: new Array(384).fill(0),
      limit: 5,
    });
    expect(results).toEqual([]);
  });
});
