/**
 * @fileoverview Helpers for inferring model capabilities (provider, reasoning support).
 * @module lib/ai/model-capabilities
 */

import type { HttpClient } from "@/lib/context";
import type { ModelCapabilities, ModelProviderId, Settings } from "@/lib/types";

const OLLAMA_THINKING_URL = "https://ollama.com/search?c=thinking";

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
 * Fetches the set of Ollama model families that support thinking mode by querying
 * the public Ollama search page for thinking models.
 *
 * @param http - HTTP client from the app context.
 * @returns Set of model family slugs (e.g. "qwen3.5", "gpt-oss").
 */
async function fetchOllamaThinkingFamilies(http: HttpClient): Promise<Set<string>> {
  const families = new Set<string>();
  try {
    const res = await http.fetch(OLLAMA_THINKING_URL);
    if (!res.ok) return families;
    const text = await res.text();
    const regex = /\/library\/([a-zA-Z0-9._-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const slug = match[1];
      if (slug) families.add(slug);
    }
  } catch {
    // Network errors: return empty set and fall back to local heuristics.
  }
  return families;
}

/**
 * Determines whether a given Ollama model supports reasoning/think based on the
 * fetched family slugs and local heuristics.
 *
 * @param model - Full model identifier (e.g. "ollama/qwen3.5:latest").
 * @param thinkingFamilies - Set of Ollama thinking model family slugs.
 */
function ollamaSupportsReasoning(model: string, thinkingFamilies: Set<string>): boolean {
  const bare = model.replace(/^ollama\//, "").split(":")[0];

  // If we have thinking families, check for direct or prefix matches.
  if (thinkingFamilies.size > 0) {
    for (const family of thinkingFamilies) {
      if (bare === family || bare.startsWith(`${family}-`) || bare.startsWith(`${family}_`)) {
        return true;
      }
    }
  }

  // Fallback heuristic: treat obvious embedding models as not supporting reasoning.
  const lower = bare.toLowerCase();
  if (lower.includes("embed") || lower.includes("embedding")) {
    return false;
  }

  return true;
}

/**
 * Computes capabilities for all whitelisted models using provider inference and,
 * for Ollama, the public thinking-models catalog where available.
 *
 * @param settings - App settings (whitelistedModels, provider URLs/keys).
 * @param http - HTTP client from app context.
 */
export async function getModelCapabilitiesForSettings(
  settings: Settings,
  http: HttpClient,
): Promise<Record<string, ModelCapabilities>> {
  const modelCapabilities: Record<string, ModelCapabilities> = {};

  const ollamaThinkingFamilies = await fetchOllamaThinkingFamilies(http);

  for (const model of settings.whitelistedModels) {
    const provider = inferProvider(model);

    let supportsReasoning = true;
    if (provider === "ollama") {
      supportsReasoning = ollamaSupportsReasoning(model, ollamaThinkingFamilies);
    } else {
      // For non-Ollama providers, default to supporting reasoning; future improvements
      // can add provider-specific capability lookups here.
      supportsReasoning = true;
    }

    modelCapabilities[model] = { provider, supportsReasoning };
  }

  return modelCapabilities;
}

