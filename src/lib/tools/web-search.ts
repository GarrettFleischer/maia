/**
 * @fileoverview Web search tool using DuckDuckGo HTML (no-JS) endpoint.
 * @module lib/tools/web-search
 */
import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { filterText } from "../security/injection-filter";
import type { Tool, ToolContext } from "./types";
import type { SearchResult } from "../types";

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";

const schema = z.object({
  query: z.string().describe("Search query"),
  maxResults: z.number().optional().describe("Maximum number of results (default 5)"),
});

/**
 * @brief Build application/x-www-form-urlencoded body for DDG HTML search.
 * @param query - Search query (will be encoded).
 * @returns Encoded form body string.
 */
function buildDuckDuckGoFormBody(query: string): string {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("b", "");
  params.set("kl", "wt-wt");
  return params.toString();
}

/**
 * @brief Fetch DuckDuckGo HTML search and parse results.
 * Uses POST with form data and browser-like headers to satisfy DDG's endpoint.
 * @param query - Search query.
 * @param max - Maximum number of results to return.
 * @param ctx - Tool context providing HTTP client.
 * @returns Array of search results (title, url, snippet, fetchedAt).
 * @throws Error if the HTTP response is not ok or request fails.
 */
async function searchDuckDuckGo(query: string, max: number, ctx: ToolContext): Promise<SearchResult[]> {
  const body = buildDuckDuckGoFormBody(query);
  const resp = await ctx.http.fetch(DDG_HTML_URL, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://html.duckduckgo.com/",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!resp.ok) {
    throw new Error(`Web search failed: ${resp.status} ${resp.status === 403 ? "(blocked or forbidden)" : ""}`);
  }

  const html = await resp.text();

  // DDG may return a CAPTCHA/challenge page when bot detection triggers
  if (/id=["']challenge-form["']/i.test(html)) {
    return [];
  }

  // Extract results from DDG HTML (result__a / result__snippet structure)
  const results: SearchResult[] = [];
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  const urls: string[] = [];
  const titles: string[] = [];
  const snippets: string[] = [];

  while ((match = resultRegex.exec(html)) !== null && urls.length < max) {
    urls.push(match[1]);
    titles.push(match[2].replace(/<[^>]+>/g, ""));
  }

  while ((match = snippetRegex.exec(html)) !== null && snippets.length < max) {
    snippets.push(match[1].replace(/<[^>]+>/g, ""));
  }

  for (let i = 0; i < Math.min(urls.length, max); i++) {
    const rawSnippet = snippets[i] ?? "";
    const filtered = filterText(rawSnippet, `web_search:${urls[i]}`);
    results.push({
      title: titles[i] ?? "",
      url: urls[i],
      snippet: filtered.text,
      fetchedAt: new Date().toISOString(),
      injectionWarning: filtered.redacted ? "Content was filtered for potential injection" : undefined,
    });
  }

  return results;
}

export const webSearchTool: Tool<z.infer<typeof schema>, SearchResult[]> = {
  name: "web_search",
  description: "Search the web and return filtered results.",
  schema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(schema) };
  },
  async execute({ query, maxResults }, ctx) {
    const max = maxResults ?? 5;
    return searchDuckDuckGo(query, max, ctx);
  },
};
