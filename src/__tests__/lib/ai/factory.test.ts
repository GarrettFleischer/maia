/**
 * @fileoverview Tests for AI provider factory (createProvider).
 * @module __tests__/lib/ai/factory.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext, FakeHttp } from "../../helpers/fakes";
import { createProvider } from "@/lib/ai/factory";
import { OllamaProvider } from "@/lib/ai/ollama";
import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { updateSettings } from "@/lib/settings";
import type { AppContext } from "@/lib/context";

describe("createProvider", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("throws when model is not whitelisted", () => {
    expect(() => createProvider("ollama/unknown-model", ctx)).toThrow(
      "Model not whitelisted"
    );
  });

  it("returns OllamaProvider for ollama/ models", () => {
    const provider = createProvider("ollama/llama3.2", ctx);
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it("returns OpenRouterProvider for openrouter/ models when API key is set", () => {
    updateSettings(ctx, { openRouterApiKey: "sk-test-key" });
    const provider = createProvider("openrouter/anthropic/claude-3.5-haiku", ctx);
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it("returns OpenRouterProvider for openrouter/free when API key is set", () => {
    updateSettings(ctx, { openRouterApiKey: "sk-test-key", whitelistedModels: ["ollama/llama3.2", "openrouter/free"] });
    const provider = createProvider("openrouter/free", ctx);
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it("throws for openrouter/ when API key is not configured", () => {
    expect(() =>
      createProvider("openrouter/anthropic/claude-3.5-haiku", ctx)
    ).toThrow("OpenRouter API key not configured");
  });

  it("throws for unknown provider prefix when model is whitelisted", () => {
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2", "custom/my-model"],
    });
    expect(() => createProvider("custom/my-model", ctx)).toThrow(
      "Unknown model provider"
    );
  });

  it("passes modelParams to OllamaProvider when set in settings", async () => {
    const http = new FakeHttp();
    const testCtx = makeTestContext({ http });
    updateSettings(testCtx, {
      whitelistedModels: ["ollama/llama3.2"],
      modelParams: { "ollama/llama3.2": { temperature: 0.6, top_p: 0.95 } },
    });
    let capturedBody: Record<string, unknown> = {};
    const ollamaLine = JSON.stringify({ message: { content: "" }, done: true }) + "\n";
    http.on(/\/api\/chat/, async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(ollamaLine));
          c.close();
        },
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        body: stream,
        text: async () => ollamaLine,
        json: async () => JSON.parse(ollamaLine),
      });
    });
    const provider = createProvider("ollama/llama3.2", testCtx);
    await provider.complete([{ role: "user", content: "Hi" }], [], () => {});
    expect(capturedBody.options).toEqual({ temperature: 0.6, top_p: 0.95 });
  });
});
