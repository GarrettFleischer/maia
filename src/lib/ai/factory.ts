import { getSettings } from "../settings";
import type { AppContext } from "../context";
import type { ReasoningEffort } from "../types";
import type { AIProvider } from "./types";
import { OllamaProvider } from "./ollama";
import { OpenRouterProvider } from "./openrouter";
import { VllmProvider } from "./vllm";
import { DockerProvider } from "./docker";

/** Options passed when creating a provider (e.g. per-agent reasoning effort). */
export interface CreateProviderOptions {
  reasoningEffort?: ReasoningEffort;
}

export function createProvider(
  model: string,
  ctx: AppContext,
  options?: CreateProviderOptions,
): AIProvider {
  if (model == null || typeof model !== "string" || model.trim() === "") {
    throw new Error(`Invalid or missing model: ${String(model)}`);
  }
  const settings = getSettings(ctx);
  const reasoningEffort = options?.reasoningEffort ?? "medium";

  if (!settings.whitelistedModels.includes(model)) {
    throw new Error(`Model not whitelisted: ${model}`);
  }

  if (model.startsWith("ollama/")) {
    return new OllamaProvider(
      model,
      settings.ollamaBaseUrl,
      ctx.http,
      settings.ollamaApiKey,
      reasoningEffort,
    );
  }

  if (model.startsWith("openrouter/")) {
    if (!settings.openRouterApiKey) {
      throw new Error("OpenRouter API key not configured");
    }
    return new OpenRouterProvider(
      model,
      settings.openRouterApiKey,
      ctx.http,
      reasoningEffort,
    );
  }

  if (model.startsWith("vllm/")) {
    return new VllmProvider(model, settings.vllmBaseUrl, ctx.http);
  }

  if (model.startsWith("docker/")) {
    return new DockerProvider(model, settings.dockerBaseUrl, ctx.http);
  }

  throw new Error(`Unknown model provider for: ${model}`);
}
