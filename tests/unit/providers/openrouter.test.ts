/**
 * @fileoverview Unit tests for the OpenRouter LLM provider adapter.
 * @module tests/unit/providers/openrouter
 */

import { describe, it, expect } from "bun:test";
import { createOpenRouterProvider } from "../../../src/providers/openrouter.js";
import { capturingLogger, mockHttpClient, mockCredentialStore } from "../../helpers/index.js";
import type { HttpResponse } from "../../../src/core/types.js";

describe("OpenRouterProvider", () => {
  function setup(responses?: Map<string, HttpResponse>) {
    const logger = capturingLogger();
    const http = mockHttpClient(responses);
    const credentials = mockCredentialStore({ "or-key": "sk-or-test123" });
    const provider = createOpenRouterProvider({
      http,
      credentials,
      logger,
      credentialName: "or-key",
      model: "openai/gpt-3.5-turbo",
    });
    return { provider, http, logger, credentials };
  }

  // ── Identity ─────────────────────────────────────────────────────

  it("should have id 'openrouter' and name 'OpenRouter'", () => {
    const { provider } = setup();
    expect(provider.id).toBe("openrouter");
    expect(provider.name).toBe("OpenRouter");
  });

  // ── Chat ─────────────────────────────────────────────────────────

  it("should parse SSE chat response from OpenRouter", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Routed"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":" reply"},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n");

    const { provider } = setup(new Map([
      ["https://openrouter.ai/api/v1/chat/completions", { status: 200, headers: {}, body, ok: true }],
    ]));

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "Hi" }])) {
      chunks.push(chunk.content);
    }
    expect(chunks.join("")).toBe("Routed reply");
  });

  it("should include HTTP-Referer header", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\ndata: [DONE]';
    const { provider, http } = setup(new Map([
      ["https://openrouter.ai/api/v1/chat/completions", { status: 200, headers: {}, body, ok: true }],
    ]));

    const gen = provider.chat([{ role: "user", content: "Hi" }]);
    for await (const _chunk of gen) { /* consume */ }

    const opts = http.calls[0].options as Record<string, unknown>;
    const headers = opts.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://github.com/maia-ai");
    expect(headers.Authorization).toBe("Bearer sk-or-test123");
  });

  it("should throw ProviderError on API failure", async () => {
    const { provider } = setup(new Map([
      ["https://openrouter.ai/api/v1/chat/completions", { status: 502, headers: {}, body: "Bad gateway", ok: false }],
    ]));

    const gen = provider.chat([{ role: "user", content: "Hi" }]);
    await expect(gen.next()).rejects.toThrow();
  });

  // ── listModels ───────────────────────────────────────────────────

  it("should list models from OpenRouter", async () => {
    const body = JSON.stringify({
      data: [
        { id: "openai/gpt-3.5-turbo", name: "GPT-3.5 Turbo", context_length: 16384 },
        { id: "anthropic/claude-3-haiku", name: "Claude 3 Haiku", context_length: 200000 },
      ],
    });

    const { provider } = setup(new Map([
      ["https://openrouter.ai/api/v1/models", { status: 200, headers: {}, body, ok: true }],
    ]));

    const models = await provider.listModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("openai/gpt-3.5-turbo");
    expect(models[0].contextWindow).toBe(16384);
    expect(models[1].contextWindow).toBe(200000);
  });

  // ── Health check ─────────────────────────────────────────────────

  it("should return true for healthy OpenRouter", async () => {
    const { provider } = setup(new Map([
      ["https://openrouter.ai/api/v1/models", { status: 200, headers: {}, body: '{"data":[]}', ok: true }],
    ]));

    expect(await provider.healthCheck()).toBe(true);
  });

  it("should return false when OpenRouter is unreachable", async () => {
    const { provider } = setup(new Map([
      ["https://openrouter.ai/api/v1/models", { status: 503, headers: {}, body: "down", ok: false }],
    ]));

    expect(await provider.healthCheck()).toBe(false);
  });

  // ── Context window size ──────────────────────────────────────────

  it("should return 4096 as default", () => {
    const { provider } = setup();
    expect(provider.contextWindowSize("any-model")).toBe(4096);
  });
});
