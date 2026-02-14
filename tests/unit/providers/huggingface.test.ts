/**
 * @fileoverview Unit tests for the Hugging Face LLM provider adapter.
 * @module tests/unit/providers/huggingface
 */

import { describe, it, expect } from "bun:test";
import { createHuggingFaceProvider } from "../../../src/providers/huggingface.js";
import { capturingLogger, mockHttpClient, mockCredentialStore } from "../../helpers/index.js";
import type { HttpResponse } from "../../../src/core/types.js";

describe("HuggingFaceProvider", () => {
  function setup(responses?: Map<string, HttpResponse>) {
    const logger = capturingLogger();
    const http = mockHttpClient(responses);
    const credentials = mockCredentialStore({ "hf-token": "hf_test123" });
    const provider = createHuggingFaceProvider({
      http,
      credentials,
      logger,
      credentialName: "hf-token",
      model: "meta-llama/Llama-2-7b-chat-hf",
    });
    return { provider, http, logger, credentials };
  }

  // ── Identity ─────────────────────────────────────────────────────

  it("should have id 'huggingface' and name 'Hugging Face'", () => {
    const { provider } = setup();
    expect(provider.id).toBe("huggingface");
    expect(provider.name).toBe("Hugging Face");
  });

  // ── Chat ─────────────────────────────────────────────────────────

  it("should parse HF text-generation response", async () => {
    const body = JSON.stringify([{ generated_text: "I'm a helpful assistant." }]);

    const { provider } = setup(new Map([
      ["https://api-inference.huggingface.co/models/meta-llama/Llama-2-7b-chat-hf", {
        status: 200, headers: {}, body, ok: true,
      }],
    ]));

    const chunks: string[] = [];
    for await (const chunk of provider.chat([{ role: "user", content: "Hello" }])) {
      chunks.push(chunk.content);
    }
    expect(chunks.join("")).toBe("I'm a helpful assistant.");
  });

  it("should format messages as prompt", async () => {
    const body = JSON.stringify([{ generated_text: "ok" }]);
    const { provider, http } = setup(new Map([
      ["https://api-inference.huggingface.co/models/meta-llama/Llama-2-7b-chat-hf", {
        status: 200, headers: {}, body, ok: true,
      }],
    ]));

    const gen = provider.chat([
      { role: "system", content: "Be helpful" },
      { role: "user", content: "Hi" },
    ]);
    for await (const _chunk of gen) { /* consume */ }

    const callBody = JSON.parse((http.calls[0].options as Record<string, string>).body);
    expect(callBody.inputs).toContain("Be helpful");
    expect(callBody.inputs).toContain("User: Hi");
  });

  it("should include Authorization header with Bearer token", async () => {
    const body = JSON.stringify([{ generated_text: "ok" }]);
    const { provider, http } = setup(new Map([
      ["https://api-inference.huggingface.co/models/meta-llama/Llama-2-7b-chat-hf", {
        status: 200, headers: {}, body, ok: true,
      }],
    ]));

    const gen = provider.chat([{ role: "user", content: "Hi" }]);
    for await (const _chunk of gen) { /* consume */ }

    const opts = http.calls[0].options as Record<string, unknown>;
    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer hf_test123");
  });

  it("should throw ProviderError on API failure", async () => {
    const { provider } = setup(new Map([
      ["https://api-inference.huggingface.co/models/meta-llama/Llama-2-7b-chat-hf", {
        status: 500, headers: {}, body: "Model error", ok: false,
      }],
    ]));

    const gen = provider.chat([{ role: "user", content: "Hi" }]);
    await expect(gen.next()).rejects.toThrow();
  });

  // ── listModels ───────────────────────────────────────────────────

  it("should list the configured model", async () => {
    const body = JSON.stringify({ modelId: "meta-llama/Llama-2-7b-chat-hf" });
    const { provider } = setup(new Map([
      ["https://api-inference.huggingface.co/models/meta-llama/Llama-2-7b-chat-hf", {
        status: 200, headers: {}, body, ok: true,
      }],
    ]));

    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("meta-llama/Llama-2-7b-chat-hf");
    expect(models[0].contextWindow).toBe(4096);
  });

  // ── Health check ─────────────────────────────────────────────────

  it("should return true for healthy HF model", async () => {
    const { provider } = setup(new Map([
      ["https://api-inference.huggingface.co/models/meta-llama/Llama-2-7b-chat-hf", {
        status: 200, headers: {}, body: '{}', ok: true,
      }],
    ]));

    expect(await provider.healthCheck()).toBe(true);
  });

  it("should return false when HF is unreachable", async () => {
    const { provider } = setup(new Map([
      ["https://api-inference.huggingface.co/models/meta-llama/Llama-2-7b-chat-hf", {
        status: 503, headers: {}, body: "unavailable", ok: false,
      }],
    ]));

    expect(await provider.healthCheck()).toBe(false);
  });

  // ── Context window size ──────────────────────────────────────────

  it("should always return 4096", () => {
    const { provider } = setup();
    expect(provider.contextWindowSize("any-model")).toBe(4096);
  });
});
