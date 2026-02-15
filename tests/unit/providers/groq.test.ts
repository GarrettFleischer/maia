/**
 * @fileoverview Unit tests for the Groq LLM provider adapter.
 * @module tests/unit/providers/groq
 */

import { describe, it, expect } from "bun:test";
import { createGroqProvider } from "../../../src/providers/groq.js";
import { capturingLogger, mockHttpClient, mockCredentialStore } from "../../helpers/index.js";
import type { HttpResponse } from "../../../src/core/types.js";

describe("GroqProvider", () => {
  function setup(responses?: Map<string, HttpResponse>) {
    const logger = capturingLogger();
    const http = mockHttpClient(responses);
    const credentials = mockCredentialStore({ "groq-key": "gsk_test123" });
    const provider = createGroqProvider({
      http,
      credentials,
      logger,
      credentialName: "groq-key",
      model: "llama-3.1-70b-versatile",
    });
    return { provider, http, logger, credentials };
  }

  // ── Identity ─────────────────────────────────────────────────────

  it("should have id 'groq' and name 'Groq'", () => {
    const { provider } = setup();
    expect(provider.id).toBe("groq");
    expect(provider.name).toBe("Groq");
  });

  // ── Chat ─────────────────────────────────────────────────────────

  it("should parse SSE chat response from Groq", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":" there!"},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n");

    const { provider } = setup(new Map([
      ["https://api.groq.com/openai/v1/chat/completions", { status: 200, headers: {}, body, ok: true }],
    ]));

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "Hi" }])) {
      chunks.push(chunk.content);
    }
    expect(chunks.join("")).toBe("Hello there!");
  });

  it("should include tools in request when options.tools is provided", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\ndata: [DONE]';
    const { provider, http } = setup(new Map([
      ["https://api.groq.com/openai/v1/chat/completions", { status: 200, headers: {}, body, ok: true }],
    ]));

    const tools = [
      { name: "agent_create", description: "Create agent", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    ];
    const gen = provider.chat([{ role: "user", content: "Hi" }], { tools });
    for await (const _chunk of gen) { /* consume */ }

    const callBody = JSON.parse((http.calls[0].options as Record<string, string>).body);
    expect(callBody.tools).toBeDefined();
    expect(Array.isArray(callBody.tools)).toBe(true);
    expect(callBody.tools[0].type).toBe("function");
    expect(callBody.tools[0].function.name).toBe("agent_create");
  });

  it("should yield toolCalls when stream contains tool_calls", async () => {
    const body = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"agent_create","arguments":"{\\"id\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
    ].join("\n");
    const { provider } = setup(new Map([
      ["https://api.groq.com/openai/v1/chat/completions", { status: 200, headers: {}, body, ok: true }],
    ]));

    const tools = [
      { name: "agent_create", description: "Create agent", parameters: { type: "object", properties: {} } },
    ];
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    for await (const chunk of provider.chat([{ role: "user", content: "Create agent x" }], { tools })) {
      if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls);
    }
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("agent_create");
    expect(toolCalls[0].arguments).toEqual({ id: "x" });
  });

  it("should include Authorization header with API key", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\ndata: [DONE]';
    const { provider, http } = setup(new Map([
      ["https://api.groq.com/openai/v1/chat/completions", { status: 200, headers: {}, body, ok: true }],
    ]));

    const gen = provider.chat([{ role: "user", content: "test" }]);
    for await (const _chunk of gen) { /* consume */ }

    const call = http.calls[0];
    const opts = call.options as Record<string, unknown>;
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gsk_test123");
  });

  it("should throw ProviderError on API failure", async () => {
    const { provider } = setup(new Map([
      ["https://api.groq.com/openai/v1/chat/completions", { status: 429, headers: {}, body: "Rate limited", ok: false }],
    ]));

    const gen = provider.chat([{ role: "user", content: "Hi" }]);
    await expect(gen.next()).rejects.toThrow();
  });

  // ── listModels ───────────────────────────────────────────────────

  it("should list models from Groq", async () => {
    const body = JSON.stringify({
      data: [
        { id: "llama-3.1-70b-versatile" },
        { id: "mixtral-8x7b-32768" },
      ],
    });

    const { provider } = setup(new Map([
      ["https://api.groq.com/openai/v1/models", { status: 200, headers: {}, body, ok: true }],
    ]));

    const models = await provider.listModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("llama-3.1-70b-versatile");
    expect(models[1].contextWindow).toBe(32768); // mixtral
  });

  // ── Health check ─────────────────────────────────────────────────

  it("should return true for healthy Groq", async () => {
    const { provider } = setup(new Map([
      ["https://api.groq.com/openai/v1/models", { status: 200, headers: {}, body: '{"data":[]}', ok: true }],
    ]));

    expect(await provider.healthCheck()).toBe(true);
  });

  it("should return false when Groq is unreachable", async () => {
    const { provider } = setup(new Map([
      ["https://api.groq.com/openai/v1/models", { status: 503, headers: {}, body: "down", ok: false }],
    ]));

    expect(await provider.healthCheck()).toBe(false);
  });

  // ── Context window size ──────────────────────────────────────────

  it("should return 128000 for llama models", () => {
    const { provider } = setup();
    expect(provider.contextWindowSize("llama-3.1-70b-versatile")).toBe(128000);
  });

  it("should return 32768 for mixtral models", () => {
    const { provider } = setup();
    expect(provider.contextWindowSize("mixtral-8x7b-32768")).toBe(32768);
  });

  it("should return 8192 for unknown models", () => {
    const { provider } = setup();
    expect(provider.contextWindowSize("unknown-model")).toBe(8192);
  });
});
