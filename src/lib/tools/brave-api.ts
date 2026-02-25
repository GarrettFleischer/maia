/**
 * @fileoverview Shared config and helpers for Brave Search API (web search and Answers).
 * @module lib/tools/brave-api
 */

import type { AppContext } from "../context";
import { credentialGet } from "../security/credential-vault";
import { BRAVE_ANSWERS_CREDENTIAL_KEY, BRAVE_SEARCH_CREDENTIAL_KEY } from "../settings";

/** Brave Web Search API endpoint (returns list of search results). */
export const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

/** Brave Answers API endpoint (OpenAI-compatible chat completions, web-grounded answers). */
export const BRAVE_ANSWERS_URL = "https://api.search.brave.com/res/v1/chat/completions";

/**
 * @brief Read Brave Search API key from encrypted vault (when set in Settings) or environment.
 * @param ctx - App context (for vault access).
 * @returns API key or empty string if unset in both vault and env.
 * @note Used by web_search. Prefer vault (Settings UI) over env.
 */
export function getBraveSearchApiKey(ctx: AppContext): string {
  try {
    const vaultKey = credentialGet(ctx, BRAVE_SEARCH_CREDENTIAL_KEY);
    if (typeof vaultKey === "string" && vaultKey.trim().length > 0) return vaultKey.trim();
  } catch {
    // Credential not in vault; fall back to env
  }
  const key = process.env.BRAVE_SEARCH_API_KEY;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : "";
}

/**
 * @brief Read Brave Answers API key from encrypted vault (when set in Settings) or environment.
 * @param ctx - App context (for vault access).
 * @returns API key or empty string if unset in both vault and env.
 * @note Separate product/billing from Brave Search. Used by brave_answers. Prefer vault over env.
 */
export function getBraveAnswersApiKey(ctx: AppContext): string {
  try {
    const vaultKey = credentialGet(ctx, BRAVE_ANSWERS_CREDENTIAL_KEY);
    if (typeof vaultKey === "string" && vaultKey.trim().length > 0) return vaultKey.trim();
  } catch {
    // Credential not in vault; fall back to env
  }
  const key = process.env.BRAVE_ANSWERS_API_KEY;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : "";
}
