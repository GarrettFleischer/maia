/**
 * @fileoverview Tests for semantic search robustness when embeddings fail.
 * @module __tests__/lib/knowledge/search.smart-context.test
 */
import { describe, it, expect } from "bun:test";
import { makeTestContext, FakeHttp, FakeResponse } from "@/__tests__/helpers/fakes";
import { updateSettings } from "@/lib/settings";
import { searchKnowledge, searchHistory } from "@/lib/knowledge/search";
import { buildRawRetrievedContext } from "@/lib/agent/context-query";
import type { EmbeddingAdapter } from "@/lib/knowledge/embedding";
import type { AppContext } from "@/lib/context";

describe("semantic search robustness when embeddings fail", () => {
  function makeThrowingEmbedder(): EmbeddingAdapter {
    return {
      async embed(): Promise<number[]> {
        throw new Error("embedding service unavailable");
      },
    };
  }

  it("searchKnowledge returns empty array when embedder throws", async () => {
    const ctx = makeTestContext();
    const embedder = makeThrowingEmbedder();

    const results = await searchKnowledge(ctx, embedder, "test query");
    expect(results).toEqual([]);
  });

  it("searchHistory returns empty array when embedder throws", async () => {
    const ctx = makeTestContext();
    const embedder = makeThrowingEmbedder();

    const results = await searchHistory(ctx, embedder, "test query");
    expect(results).toEqual([]);
  });

  it("buildRawRetrievedContext returns no context when embedding HTTP calls fail", async () => {
    const http = new FakeHttp();
    // Cause all embed calls to fail with a 500 so the adapter throws.
    http.on("/api/embed", async () => new FakeResponse(500, "embed error"));

    const ctx: AppContext = makeTestContext({ http });
    updateSettings(ctx, {
      whitelistedModels: ["ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
    });
    const { text, sources, contents } = await buildRawRetrievedContext(ctx, ["foo", "bar"]);

    expect(text).toBe("No relevant prior context found.");
    expect(sources).toEqual([]);
    expect(contents).toEqual([]);
  });
});

