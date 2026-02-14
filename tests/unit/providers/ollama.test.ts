/**
 * @fileoverview Unit tests for the Ollama LLM provider adapter.
 * @module tests/unit/providers/ollama
 */

import { describe, it, expect } from "bun:test";
import { createOllamaProvider } from "../../../src/providers/ollama.js";
import { capturingLogger, mockHttpClient } from "../../helpers/index.js";
import type { HttpResponse } from "../../../src/core/types.js";

describe("OllamaProvider", () => {
  function setup(responses?: Map<string, HttpResponse>) {
    const logger = capturingLogger();
    const http = mockHttpClient(responses);
    const provider = createOllamaProvider({
      http,
      logger,
      baseUrl: "http://localhost:11434",
      model: "llama3.2",
    });
    return { provider, http, logger };
  }

  // ── Identity ─────────────────────────────────────────────────────

  it("should have id 'ollama' and name 'Ollama'", () => {
    const { provider } = setup();
    expect(provider.id).toBe("ollama");
    expect(provider.name).toBe("Ollama");
  });

  // ── Chat ─────────────────────────────────────────────────────────

  it("should stream chat response from Ollama", async () => {
    const body = [
      JSON.stringify({ message: { content: "Hello" }, done: false }),
      JSON.stringify({ message: { content: " world!" }, done: true }),
    ].join("\n");

    const { provider } = setup(new Map([
      ["http://localhost:11434/api/chat", { status: 200, headers: {}, body, ok: true }],
    ]));

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "Hi" }])) {
      chunks.push(chunk.content);
    }

    expect(chunks.join("")).toBe("Hello world!");
  });

  it("should throw ProviderError on chat API failure", async () => {
    const { provider } = setup(new Map([
      ["http://localhost:11434/api/chat", { status: 500, headers: {}, body: "Internal error", ok: false }],
    ]));

    const gen = provider.chat([{ role: "user", content: "Hi" }]);
    await expect(gen.next()).rejects.toThrow();
  });

  // ── listModels ───────────────────────────────────────────────────

  it("should list models from Ollama", async () => {
    const body = JSON.stringify({
      models: [
        { name: "llama3.2", details: { parameter_size: "3B" } },
        { name: "llama3.1:8b", details: { parameter_size: "8B" } },
      ],
    });

    const { provider } = setup(new Map([
      ["http://localhost:11434/api/tags", { status: 200, headers: {}, body, ok: true }],
    ]));

    const models = await provider.listModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("llama3.2");
    expect(models[1].id).toBe("llama3.1:8b");
  });

  // ── Health check ─────────────────────────────────────────────────

  it("should return true for healthy Ollama", async () => {
    const { provider } = setup(new Map([
      ["http://localhost:11434/api/tags", { status: 200, headers: {}, body: '{"models":[]}', ok: true }],
    ]));

    const healthy = await provider.healthCheck();
    expect(healthy).toBe(true);
  });

  it("should return false for unhealthy Ollama", async () => {
    const { provider } = setup(new Map([
      ["http://localhost:11434/api/tags", { status: 500, headers: {}, body: "error", ok: false }],
    ]));

    const healthy = await provider.healthCheck();
    expect(healthy).toBe(false);
  });

  // ── Context window size ──────────────────────────────────────────

  it("should return 8192 for llama3.1 models", () => {
    const { provider } = setup();
    expect(provider.contextWindowSize("llama3.1:70b")).toBe(8192);
  });

  it("should return 4096 for non-llama3.1 models", () => {
    const { provider } = setup();
    expect(provider.contextWindowSize("llama3.2")).toBe(4096);
  });

  // ── Embed ────────────────────────────────────────────────────────

  it("should embed texts", async () => {
    const body = JSON.stringify({ embeddings: [[0.1, 0.2], [0.3, 0.4]] });
    const { provider } = setup(new Map([
      ["http://localhost:11434/api/embed", { status: 200, headers: {}, body, ok: true }],
    ]));

    const embeddings = await provider.embed(["Hello", "World"]);
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toEqual([0.1, 0.2]);
  });
});
