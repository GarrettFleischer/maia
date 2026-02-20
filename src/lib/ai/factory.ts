import { getSettings } from "../settings";
import type { AIProvider } from "./types";
import { OllamaProvider } from "./ollama";
import { OpenRouterProvider } from "./openrouter";

export function createProvider(model: string): AIProvider {
  const settings = getSettings();

  if (!settings.whitelistedModels.includes(model)) {
    throw new Error(`Model not whitelisted: ${model}`);
  }

  if (model.startsWith("ollama/")) {
    return new OllamaProvider(model, settings.ollamaBaseUrl);
  }

  if (model.startsWith("openrouter/")) {
    if (!settings.openRouterApiKey) {
      throw new Error("OpenRouter API key not configured");
    }
    return new OpenRouterProvider(model, settings.openRouterApiKey);
  }

  throw new Error(`Unknown model provider for: ${model}`);
}
