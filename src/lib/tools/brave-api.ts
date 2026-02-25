/**
 * @fileoverview Shared config and helpers for Brave Search API (web search and Answers).
 * @module lib/tools/brave-api
 */

/** Brave Web Search API endpoint (returns list of search results). */
export const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

/** Brave Answers API endpoint (OpenAI-compatible chat completions, web-grounded answers). */
export const BRAVE_ANSWERS_URL = "https://api.search.brave.com/res/v1/chat/completions";

/**
 * @brief Read Brave Search API key from environment.
 * @returns API key or empty string if unset.
 * @note Both web_search and brave_answers require this key; no fallback.
 */
export function getBraveSearchApiKey(): string {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : "";
}
