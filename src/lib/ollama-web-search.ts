/**
 * @fileoverview Client for Ollama cloud web search and web fetch APIs (ollama.com).
 * Requires OLLAMA_API_KEY. Used by web_search and web_fetch tools when key is set.
 * @module lib/ollama-web-search
 */

export type WebSearchResultItem = {
  title: string;
  url: string;
  content: string;
};

export type WebSearchResponse = {
  results: WebSearchResultItem[];
};

export type WebFetchResponse = {
  title: string;
  content: string;
  links: string[];
};

const OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search";
const OLLAMA_FETCH_URL = "https://ollama.com/api/web_fetch";

/** Fetch-like function for tests (avoids requiring full global fetch type). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Performs a web search via Ollama's cloud API.
 *
 * @brief POST to ollama.com/api/web_search with query and optional max_results (capped 1-10).
 * @param query - Search query string.
 * @param maxResults - Optional max results (default 5, max 10).
 * @param fetchFn - Fetch implementation (for tests). Defaults to global fetch.
 * @returns Typed result with results array of { title, url, content }.
 * @throws Error when OLLAMA_API_KEY is missing/empty or when the API returns non-ok.
 * @example
 *   const r = await ollamaWebSearch("what is ollama?", 5);
 *   console.log(r.results[0].title);
 */
export async function ollamaWebSearch(
  query: string,
  maxResults?: number,
  fetchFn: FetchLike = fetch
): Promise<WebSearchResponse> {
  const key = process.env.OLLAMA_API_KEY?.trim();
  if (!key) {
    throw new Error("OLLAMA_API_KEY not set");
  }
  const max = maxResults != null ? Math.min(10, Math.max(1, Math.floor(maxResults))) : 5;
  const res = await fetchFn(OLLAMA_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, max_results: max }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama web search ${res.status}: ${text}`);
  }
  const data = (await res.json()) as WebSearchResponse;
  return data;
}

/**
 * Fetches full content of a URL via Ollama's cloud API.
 *
 * @brief POST to ollama.com/api/web_fetch with url.
 * @param url - URL to fetch.
 * @param fetchFn - Fetch implementation (for tests). Defaults to global fetch.
 * @returns Typed result with title, content, and links.
 * @throws Error when OLLAMA_API_KEY is missing/empty or when the API returns non-ok.
 * @example
 *   const r = await ollamaWebFetch("https://ollama.com");
 *   console.log(r.title, r.content);
 */
export async function ollamaWebFetch(
  url: string,
  fetchFn: FetchLike = fetch
): Promise<WebFetchResponse> {
  const key = process.env.OLLAMA_API_KEY?.trim();
  if (!key) {
    throw new Error("OLLAMA_API_KEY not set");
  }
  const res = await fetchFn(OLLAMA_FETCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama web fetch ${res.status}: ${text}`);
  }
  const data = (await res.json()) as WebFetchResponse;
  return data;
}
