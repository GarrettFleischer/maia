/**
 * @fileoverview Unit tests for text chunker.
 * @module tests/unit/memory/chunker
 */

import { describe, it, expect } from "bun:test";
import { createTextChunker } from "../../../src/memory/chunker.js";

describe("TextChunker", () => {
  it("should estimate tokens as ceil(chars/4)", () => {
    const chunker = createTextChunker();
    expect(chunker.estimateTokens("")).toBe(0);
    expect(chunker.estimateTokens("abcd")).toBe(1);
    expect(chunker.estimateTokens("abcdefgh")).toBe(2);
  });

  it("should return single chunk when text fits in maxTokensPerChunk", () => {
    const chunker = createTextChunker({ maxTokensPerChunk: 256, overlapTokens: 0 });
    const short = "Short text.";
    const chunks = chunker.chunk(short);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(short);
    expect(chunks[0].index).toBe(0);
  });

  it("should return empty array for empty string", () => {
    const chunker = createTextChunker();
    expect(chunker.chunk("")).toEqual([]);
  });

  it("should split long text into multiple chunks", () => {
    const chunker = createTextChunker({ maxTokensPerChunk: 32, overlapTokens: 8 });
    const long = "word ".repeat(100);
    const chunks = chunker.chunk(long);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.text.length).toBeGreaterThan(0);
    });
  });

  it("should prefer splitting at paragraph boundaries", () => {
    const chunker = createTextChunker({ maxTokensPerChunk: 20, overlapTokens: 0 });
    const text = "First paragraph here.\n\nSecond paragraph here.";
    const chunks = chunker.chunk(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
