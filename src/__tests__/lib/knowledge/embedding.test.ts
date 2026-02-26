/**
 * @fileoverview Tests for the embedding adapter (Ollama) and Ollama context length helper.
 * @module __tests__/lib/knowledge/embedding
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { FakeHttp, FakeResponse } from "../../helpers/fakes";
import {
  createOllamaEmbeddingAdapter,
  getOllamaEmbedContextLength,
  _clearOllamaEmbedContextLengthCacheForTests,
} from "@/lib/knowledge/embedding";

describe("embedding", () => {
  describe("createOllamaEmbeddingAdapter", () => {
    it("on 404 with 'try pulling' message, error includes ollama pull hint", async () => {
      const http = new FakeHttp();
      const body = '{"error":"model \\"nomic-embed-text\\" not found, try pulling it first"}';
      http.on("/api/embed", async () => new FakeResponse(404, body));

      const adapter = createOllamaEmbeddingAdapter(
        "nomic-embed-text",
        "http://localhost:11434",
        http
      );

      await expect(adapter.embed("hello")).rejects.toThrow(/Run: ollama pull nomic-embed-text/);
    });

    it("accepts response with singular embedding array", async () => {
      const http = new FakeHttp();
      const vector = [0.1, 0.2, 0.3];
      http.on(
        "/api/embed",
        async () => new FakeResponse(200, JSON.stringify({ embedding: vector }))
      );

      const adapter = createOllamaEmbeddingAdapter(
        "nomic-embed-text",
        "http://localhost:11434",
        http
      );

      const result = await adapter.embed("hello");
      expect(result).toEqual(vector);
    });

    it("on generic 500, error does not add pull hint", async () => {
      const http = new FakeHttp();
      http.on(
        "/api/embed",
        async () => new FakeResponse(500, "Internal Server Error")
      );

      const adapter = createOllamaEmbeddingAdapter(
        "nomic-embed-text",
        "http://localhost:11434",
        http
      );

      await expect(adapter.embed("hello")).rejects.toThrow(/Ollama embeddings failed \(500\)/);
      await expect(adapter.embed("hello")).rejects.not.toThrow(/Run: ollama pull/);
    });
  });

  describe("getOllamaEmbedContextLength", () => {
    let http: FakeHttp;

    beforeEach(() => {
      _clearOllamaEmbedContextLengthCacheForTests();
      http = new FakeHttp();
    });

    it("returns character budget from num_ctx in parameters (tokens * 3)", async () => {
      http.on("/api/show", async () =>
        new FakeResponse(200, JSON.stringify({ parameters: "temperature 0.1\nnum_ctx 2048\n" }))
      );
      const chars = await getOllamaEmbedContextLength("nomic-embed-text", "http://localhost:11434", http);
      expect(chars).toBe(2048 * 3);
    });

    it("uses fallback when POST /api/show fails", async () => {
      http.on("/api/show", async () => new FakeResponse(500, "error"));
      const chars = await getOllamaEmbedContextLength("nomic-embed-text", "http://localhost:11434", http);
      expect(chars).toBe(6144); // 2048 tokens * 3 default
    });

    it("uses fallback when parameters has no num_ctx", async () => {
      http.on("/api/show", async () =>
        new FakeResponse(200, JSON.stringify({ parameters: "temperature 0.7" }))
      );
      const chars = await getOllamaEmbedContextLength("nomic-embed-text", "http://localhost:11434", http);
      expect(chars).toBe(6144);
    });

    it("caches result per model so show is not called twice", async () => {
      let showCalls = 0;
      http.on("/api/show", async () => {
        showCalls++;
        return new FakeResponse(200, JSON.stringify({ parameters: "num_ctx 4096" }));
      });
      const a = await getOllamaEmbedContextLength("nomic-embed-text", "http://localhost:11434", http);
      const b = await getOllamaEmbedContextLength("nomic-embed-text", "http://localhost:11434", http);
      expect(a).toBe(4096 * 3);
      expect(b).toBe(a);
      expect(showCalls).toBe(1);
    });
  });
});
