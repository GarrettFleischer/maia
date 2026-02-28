/**
 * @fileoverview Tests for the embedding adapter (Ollama) and Ollama context length helper.
 * @module __tests__/lib/knowledge/embedding
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { FakeHttp, FakeResponse } from "../../helpers/fakes";
import {
  createEmbeddingAdapter,
  createOllamaEmbeddingAdapter,
  getOllamaEmbedContextLength,
  getEffectiveEmbedMaxLength,
  _clearOllamaEmbedContextLengthCacheForTests,
} from "@/lib/knowledge/embedding";
import type { Settings } from "@/lib/types";

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

    it("returns character budget from num_ctx in parameters (tokens * 2)", async () => {
      http.on("/api/show", async () =>
        new FakeResponse(200, JSON.stringify({ parameters: "temperature 0.1\nnum_ctx 2048\n" }))
      );
      const chars = await getOllamaEmbedContextLength("nomic-embed-text", "http://localhost:11434", http);
      expect(chars).toBe(2048 * 2);
    });

    it("uses fallback when POST /api/show fails", async () => {
      http.on("/api/show", async () => new FakeResponse(500, "error"));
      const chars = await getOllamaEmbedContextLength("nomic-embed-text", "http://localhost:11434", http);
      expect(chars).toBe(4096); // 2048 tokens * 2 default
    });

    it("uses fallback when parameters has no num_ctx", async () => {
      http.on("/api/show", async () =>
        new FakeResponse(200, JSON.stringify({ parameters: "temperature 0.7" }))
      );
      const chars = await getOllamaEmbedContextLength("nomic-embed-text", "http://localhost:11434", http);
      expect(chars).toBe(4096);
    });

    it("caches result per model so show is not called twice", async () => {
      let showCalls = 0;
      http.on("/api/show", async () => {
        showCalls++;
        return new FakeResponse(200, JSON.stringify({ parameters: "num_ctx 4096" }));
      });
      const a = await getOllamaEmbedContextLength("nomic-embed-text", "http://localhost:11434", http);
      const b = await getOllamaEmbedContextLength("nomic-embed-text", "http://localhost:11434", http);
      expect(a).toBe(4096 * 2);
      expect(b).toBe(a);
      expect(showCalls).toBe(1);
    });
  });

  describe("createEmbeddingAdapter", () => {
    it("throws when embedding model is not in whitelist", () => {
      const http = new FakeHttp();
      http.on("/api/embed", async () => new FakeResponse(200, JSON.stringify({ embeddings: [[0.1]] })));
      const settings: Settings = {
        whitelistedModels: ["ollama/llama3.2"],
        heartbeatIntervalMinutes: 30,
        ollamaBaseUrl: "http://localhost:11434",
        vllmBaseUrl: "",
        dockerBaseUrl: "",
        embeddingModel: "ollama/nomic-embed-text",
        embedMaxContentLength: 4000,
        contextQueryModel: "",
        contextSummaryModel: "",
        contextRecentTurns: 3,
        contextReasoningEffort: "medium",
      };
      expect(() => createEmbeddingAdapter(settings, http)).toThrow(/not whitelisted/);
    });

    it("creates adapter when embedding model is in whitelist", async () => {
      const http = new FakeHttp();
      const vector = [0.1, 0.2, 0.3];
      http.on("/api/embed", async () => new FakeResponse(200, JSON.stringify({ embeddings: [vector] })));
      const settings: Settings = {
        whitelistedModels: ["ollama/nomic-embed-text"],
        heartbeatIntervalMinutes: 30,
        ollamaBaseUrl: "http://localhost:11434",
        vllmBaseUrl: "",
        dockerBaseUrl: "",
        embeddingModel: "ollama/nomic-embed-text",
        embedMaxContentLength: 4000,
        contextQueryModel: "",
        contextSummaryModel: "",
        contextRecentTurns: 3,
        contextReasoningEffort: "medium",
      };
      const adapter = createEmbeddingAdapter(settings, http);
      const result = await adapter.embed("hello");
      expect(result).toEqual(vector);
    });

    it("creates OpenRouter adapter when model is openrouter/ and API key is set", async () => {
      const http = new FakeHttp();
      const vector = [0.5, 0.5, 0.5];
      http.on(
        "https://openrouter.ai/api/v1/embeddings",
        async () => new FakeResponse(200, JSON.stringify({ data: [{ embedding: vector }] }))
      );
      const settings: Settings = {
        whitelistedModels: ["openrouter/qwen/qwen3-embedding-8b"],
        heartbeatIntervalMinutes: 30,
        ollamaBaseUrl: "http://localhost:11434",
        openRouterApiKey: "sk-test",
        vllmBaseUrl: "",
        dockerBaseUrl: "",
        embeddingModel: "openrouter/qwen/qwen3-embedding-8b",
        embedMaxContentLength: 4000,
        contextQueryModel: "",
        contextSummaryModel: "",
        contextRecentTurns: 3,
        contextReasoningEffort: "medium",
      };
      const adapter = createEmbeddingAdapter(settings, http);
      const result = await adapter.embed("hello");
      expect(result).toEqual(vector);
    });
  });

  describe("getEffectiveEmbedMaxLength", () => {
    let http: FakeHttp;

    beforeEach(() => {
      _clearOllamaEmbedContextLengthCacheForTests();
      http = new FakeHttp();
    });

    it("returns effective max capped by safe upper bound even when Ollama reports large context", async () => {
      http.on("/api/show", async () =>
        new FakeResponse(200, JSON.stringify({ parameters: "num_ctx 32768" }))
      );
      const settings: Settings = {
        whitelistedModels: [],
        heartbeatIntervalMinutes: 30,
        ollamaBaseUrl: "http://localhost:11434",
        vllmBaseUrl: "",
        dockerBaseUrl: "",
        embeddingModel: "ollama/nomic-embed-text",
        embedMaxContentLength: 32000,
        contextQueryModel: "",
        contextSummaryModel: "",
        contextRecentTurns: 3,
        contextReasoningEffort: "medium",
      };
      const maxLen = await getEffectiveEmbedMaxLength(settings, http);
      expect(maxLen).toBe(4096);
    });

    it("returns min of settings and ollama when both below safe cap", async () => {
      http.on("/api/show", async () =>
        new FakeResponse(200, JSON.stringify({ parameters: "num_ctx 2048" }))
      );
      const settings: Settings = {
        whitelistedModels: [],
        heartbeatIntervalMinutes: 30,
        ollamaBaseUrl: "http://localhost:11434",
        vllmBaseUrl: "",
        dockerBaseUrl: "",
        embeddingModel: "ollama/nomic-embed-text",
        embedMaxContentLength: 4000,
        contextQueryModel: "",
        contextSummaryModel: "",
        contextRecentTurns: 3,
        contextReasoningEffort: "medium",
      };
      const maxLen = await getEffectiveEmbedMaxLength(settings, http);
      expect(maxLen).toBe(4000);
    });

    it("returns min of settings and default for non-Ollama (OpenRouter) models", async () => {
      const settings: Settings = {
        whitelistedModels: [],
        heartbeatIntervalMinutes: 30,
        ollamaBaseUrl: "http://localhost:11434",
        vllmBaseUrl: "",
        dockerBaseUrl: "",
        embeddingModel: "openrouter/qwen/qwen3-embedding-8b",
        embedMaxContentLength: 4000,
        contextQueryModel: "",
        contextSummaryModel: "",
        contextRecentTurns: 3,
        contextReasoningEffort: "medium",
      };
      const maxLen = await getEffectiveEmbedMaxLength(settings, http);
      expect(maxLen).toBe(4000);
    });
  });
});
