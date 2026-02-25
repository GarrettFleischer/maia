import { getSettings } from "../settings";
import type { AppContext } from "../context";
import type { AIProvider } from "./types";
import { OllamaProvider } from "./ollama";
import { OpenRouterProvider } from "./openrouter";
import { VllmProvider } from "./vllm";
import { DockerProvider } from "./docker";

export function createProvider(model: string, ctx: AppContext): AIProvider {
  if (model == null || typeof model !== "string" || model.trim() === "") {
    throw new Error(`Invalid or missing model: ${String(model)}`);
  }
  const settings = getSettings(ctx);

  if (!settings.whitelistedModels.includes(model)) {
    throw new Error(`Model not whitelisted: ${model}`);
  }

  if (model.startsWith("ollama/")) {
    return new OllamaProvider(model, settings.ollamaBaseUrl, ctx.http, settings.ollamaApiKey);
  }

  if (model.startsWith("openrouter/")) {
    if (!settings.openRouterApiKey) {
      throw new Error("OpenRouter API key not configured");
    }
    return new OpenRouterProvider(model, settings.openRouterApiKey, ctx.http);
  }

  if (model.startsWith("vllm/")) {
    return new VllmProvider(model, settings.vllmBaseUrl, ctx.http);
  }

  if (model.startsWith("docker/")) {
    return new DockerProvider(model, settings.dockerBaseUrl, ctx.http);
  }

  throw new Error(`Unknown model provider for: ${model}`);
}
