/**
 * @fileoverview Tests for AI provider factory (createProvider).
 * @module __tests__/lib/ai/factory.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "../../helpers/fakes";
import { createProvider } from "@/lib/ai/factory";
import { OllamaProvider } from "@/lib/ai/ollama";
import { OpenRouterProvider } from "@/lib/ai/openrouter";
import { VllmProvider } from "@/lib/ai/vllm";
import { DockerProvider } from "@/lib/ai/docker";
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

  it("throws for openrouter/ when API key is not configured", () => {
    expect(() =>
      createProvider("openrouter/anthropic/claude-3.5-haiku", ctx)
    ).toThrow("OpenRouter API key not configured");
  });

  it("returns VllmProvider for vllm/ models", () => {
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2", "vllm/Meta-Llama-3-8B-Instruct"],
    });
    const provider = createProvider("vllm/Meta-Llama-3-8B-Instruct", ctx);
    expect(provider).toBeInstanceOf(VllmProvider);
  });

  it("returns DockerProvider for docker/ models", () => {
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2", "docker/Meta-Llama-3-8B-Instruct"],
    });
    const provider = createProvider("docker/Meta-Llama-3-8B-Instruct", ctx);
    expect(provider).toBeInstanceOf(DockerProvider);
  });

  it("throws for unknown provider prefix when model is whitelisted", () => {
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2", "custom/my-model"],
    });
    expect(() => createProvider("custom/my-model", ctx)).toThrow(
      "Unknown model provider"
    );
  });
});
