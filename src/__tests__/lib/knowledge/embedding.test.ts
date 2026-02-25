/**
 * @fileoverview Tests for the embedding adapter (Ollama).
 * @module __tests__/lib/knowledge/embedding
 */

import { describe, it, expect } from "bun:test";
import { FakeHttp, FakeResponse } from "../../helpers/fakes";
import { createOllamaEmbeddingAdapter } from "@/lib/knowledge/embedding";

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
});
