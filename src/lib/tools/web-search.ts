/**
 * @fileoverview Web search tool using Brave Search API only.
 * @module lib/tools/web-search
 */
import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { filterText } from "../security/injection-filter";
import { getBraveSearchApiKey, BRAVE_WEB_SEARCH_URL } from "./brave-api";
import type { Tool, ToolContext } from "./types";
import type { SearchResult } from "../types";

const schema = z.object({
  query: z.string().describe("Search query"),
  maxResults: z.number().optional().describe("Maximum number of results (default 5)"),
});

/**
 * @brief Brave Search API response web result item.
 */
interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

/**
 * @brief Call Brave Search API and map response to SearchResult[].
 * @param query - Search query.
 * @param max - Maximum number of results to return.
 * @param ctx - Tool context providing HTTP client.
 * @returns Array of search results (title, url, snippet, fetchedAt).
 * @throws Error if BRAVE_SEARCH_API_KEY is unset or HTTP request fails.
 * @note Brave Search API uses X-Subscription-Token header.
 */
async function searchBrave(query: string, max: number, ctx: ToolContext): Promise<SearchResult[]> {
  const key = getBraveSearchApiKey(ctx);
  if (!key) {
    throw new Error(
      "Web search requires Brave Search API key. Set it in Settings or BRAVE_SEARCH_API_KEY in your environment. Get a key at https://api.search.brave.com/.",
    );
  }

  const url = `${BRAVE_WEB_SEARCH_URL}?${new URLSearchParams({ q: query }).toString()}`;
  const resp = await ctx.http.fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
  });

  if (!resp.ok) {
    throw new Error(`Web search failed: ${resp.status} ${resp.status === 401 ? "(invalid API key)" : ""}`);
  }

  const data = (await resp.json()) as { web?: { results?: BraveWebResult[] } };
  const raw = data?.web?.results ?? [];
  const results: SearchResult[] = [];
  const slice = raw.slice(0, max);

  for (const r of slice) {
    const snippet = r.description ?? "";
    const filtered = filterText(snippet, `web_search:${r.url ?? ""}`);
    results.push({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: filtered.text,
      fetchedAt: new Date().toISOString(),
      injectionWarning: filtered.redacted ? "Content was filtered for potential injection" : undefined,
    });
  }
  return results;
}

export const webSearchTool: Tool<z.infer<typeof schema>, SearchResult[]> = {
  name: "web_search",
  description:
    "Search the web using Brave Search API. Returns a list of results (title, url, snippet). Requires BRAVE_SEARCH_API_KEY to be set.",
  schema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(schema) };
  },
  async execute({ query, maxResults }, ctx) {
    const max = maxResults ?? 5;
    return searchBrave(query, max, ctx);
  },
};
