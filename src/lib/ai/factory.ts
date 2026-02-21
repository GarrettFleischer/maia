import { getSettings } from "../settings";
import type { AppContext } from "../context";
import type { AIProvider } from "./types";
import { OllamaProvider } from "./ollama";
import { OpenRouterProvider } from "./openrouter";

export function createProvider(model: string, ctx: AppContext): AIProvider {
  const settings = getSettings(ctx);

  if (!settings.whitelistedModels.includes(model)) {
    throw new Error(`Model not whitelisted: ${model}`);
  }

  if (model.startsWith("ollama/")) {
    return new OllamaProvider(model, settings.ollamaBaseUrl, ctx.http);
  }

  if (model.startsWith("openrouter/")) {
    if (!settings.openRouterApiKey) {
      throw new Error("OpenRouter API key not configured");
    }
    return new OpenRouterProvider(model, settings.openRouterApiKey, ctx.http);
  }

  throw new Error(`Unknown model provider for: ${model}`);
}
