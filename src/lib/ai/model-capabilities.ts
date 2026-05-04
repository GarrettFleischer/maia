/**
 * @fileoverview Helpers for model capabilities (provider, reasoning, tools).
 * @module lib/ai/model-capabilities
 *
 * For Ollama, capabilities are read from POST /api/show when the model is
 * installed; when unknown we do not default to true (no icons shown). If Ollama
 * does not report "thinking", we still set supportsReasoning for known
 * reasoning-capable model names (e.g. Qwen3.5, *-Reasoning, deepseek-r1).
 * OpenRouter has no capability API; we assume all OpenRouter models support
 * reasoning and tools.
 */

import type { HttpClient } from "@/lib/context";
import type { ModelCapabilities, ModelProviderId, Settings } from "@/lib/types";

/** Result of querying Ollama /api/show for a single model. Undefined when unknown. */
export interface OllamaShowCapabilities {
  supportsReasoning?: boolean;
  supportsTools?: boolean;
}

const ollamaShowCache = new Map<string, OllamaShowCapabilities>();

/**
 * Clears the Ollama show capability cache. Only for use in tests.
 * @internal
 */
export function _clearOllamaShowCapabilityCacheForTests(): void {
  ollamaShowCache.clear();
}

/**
 * True when the model name indicates a known reasoning-capable model that may not
 * advertise "thinking" in Ollama /api/show (e.g. Unsloth Qwen3.5, Ministral-Reasoning).
 * Used to show the reasoning control and pass think: true for these models.
 *
 * @param modelName - Bare model name (no ollama/ prefix).
 * @returns True if we treat this model as supporting reasoning by name.
 */
function isKnownReasoningModelByName(modelName: string): boolean {
  const name = modelName.toLowerCase();
  if (name.includes("qwen3.5")) return true;
  if (name.includes("reasoning")) return true;
  if (name.startsWith("deepseek-r1") || name.startsWith("deepseek-v3"))
    return true;
  if (name.startsWith("gpt-oss")) return true;
  return false;
}

/**
 * Fetches whether an Ollama model supports thinking and tools via POST /api/show.
 * Results are cached per (baseUrl, modelName). When the model is not installed or
 * the request fails, returns undefined for both (do not default to true).
 * If Ollama does not report "thinking", we still set supportsReasoning for
 * known reasoning-capable model names (e.g. Qwen3.5, *-Reasoning, deepseek-r1).
 *
 * @param baseUrl - Ollama server base URL (e.g. http://localhost:11434).
 * @param modelName - Model name without prefix (e.g. llama3.2 or qwen3.5:latest).
 * @param apiKey - Optional API key for Ollama Cloud.
 * @param http - HTTP client from app context.
 * @returns Object with supportsReasoning and supportsTools when known; undefined when not.
 */
export async function fetchOllamaModelCapabilities(
  baseUrl: string,
  modelName: string,
  apiKey: string | undefined,
  http: HttpClient,
): Promise<OllamaShowCapabilities> {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const cacheKey = `${normalizedBase}|${modelName}`;
  const cached = ollamaShowCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const unknown: OllamaShowCapabilities = {
    supportsReasoning: undefined,
    supportsTools: undefined,
  };

  try {
    const url = `${normalizedBase}/api/show`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await http.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: modelName }),
    });
    if (!res.ok) {
      ollamaShowCache.set(cacheKey, unknown);
      return unknown;
    }
    const data = (await res.json()) as { capabilities?: string[] };
    const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
    let supportsReasoning = caps.includes("thinking");
    const supportsTools = caps.includes("tools");
    if (supportsReasoning !== true && isKnownReasoningModelByName(modelName)) {
      supportsReasoning = true;
    }
    const result: OllamaShowCapabilities = { supportsReasoning, supportsTools };
    ollamaShowCache.set(cacheKey, result);
    return result;
  } catch {
    ollamaShowCache.set(cacheKey, unknown);
    return unknown;
  }
}

/**
 * Infers the provider id from a whitelisted model string.
 * @param model - Full model identifier from settings (e.g. "ollama/llama3.2").
 * @returns Provider identifier used by Maia.
 */
function inferProvider(model: string): ModelProviderId {
  if (model.startsWith("ollama/")) return "ollama";
  if (model.startsWith("openrouter/")) return "openrouter";
  // Default to ollama for unprefixed models; current seed data always includes prefixes.
  return "ollama";
}

/**
 * Computes capabilities for all whitelisted models. For Ollama, uses POST /api/show
 * when baseUrl is set; when not set or request fails, returns undefined (no icons).
 * OpenRouter has no capability API; we assume reasoning and tools are supported.
 *
 * @param settings - App settings (whitelistedModels, ollamaBaseUrl, ollamaApiKey).
 * @param http - HTTP client from app context.
 */
export async function getModelCapabilitiesForSettings(
  settings: Settings,
  http: HttpClient,
): Promise<Record<string, ModelCapabilities>> {
  const modelCapabilities: Record<string, ModelCapabilities> = {};
  const baseUrl = (settings.ollamaBaseUrl ?? "").replace(/\/+$/, "");

  for (const model of settings.whitelistedModels) {
    const provider = inferProvider(model);

    if (provider === "ollama") {
      const bareName = model.replace(/^ollama\//, "");
      if (baseUrl) {
        const show = await fetchOllamaModelCapabilities(
          baseUrl,
          bareName,
          settings.ollamaApiKey,
          http,
        );
        modelCapabilities[model] = {
          provider,
          supportsReasoning: show.supportsReasoning,
          supportsTools: show.supportsTools,
        };
      } else {
        modelCapabilities[model] = {
          provider,
          supportsReasoning: undefined,
          supportsTools: undefined,
        };
      }
    } else {
      // OpenRouter: no capability API; assume all models support reasoning and tools.
      modelCapabilities[model] = {
        provider,
        supportsReasoning: true,
        supportsTools: true,
      };
    }
  }

  return modelCapabilities;
}
