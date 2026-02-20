import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import { filterText } from "../security/injection-filter";
import type { Tool, ToolContext } from "./types";
import type { SearchResult } from "../types";

const schema = z.object({
  query: z.string().describe("Search query"),
  maxResults: z.number().optional().describe("Maximum number of results (default 5)"),
});

async function searchDuckDuckGo(query: string, max: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MaiaBot/1.0)" },
  });
  const html = await resp.text();

  // Extract results from DDG HTML
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
  async execute({ query, maxResults }, _ctx) {
    const max = maxResults ?? 5;
    return searchDuckDuckGo(query, max);
  },
};
