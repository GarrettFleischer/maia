/**
 * @fileoverview Tests for Ollama cloud web search/fetch API client.
 * @module tests/lib/ollama-web-search.test
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { FetchLike } from "@/lib/ollama-web-search";
import { ollamaWebSearch, ollamaWebFetch } from "@/lib/ollama-web-search";

const OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search";
const OLLAMA_FETCH_URL = "https://ollama.com/api/web_fetch";

describe("ollamaWebSearch", () => {
  const origKey = process.env.OLLAMA_API_KEY;
  const mockFetch = mock((url: string, _init?: RequestInit) => {
    if (url === OLLAMA_SEARCH_URL) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              { title: "T1", url: "https://a.com", content: "C1" },
              { title: "T2", url: "https://b.com", content: "C2" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });

  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.OLLAMA_API_KEY = origKey;
    else delete process.env.OLLAMA_API_KEY;
  });

  it("throws when OLLAMA_API_KEY is unset", async () => {
    delete process.env.OLLAMA_API_KEY;
    await expect(ollamaWebSearch("test", undefined, mockFetch as FetchLike)).rejects.toThrow("OLLAMA_API_KEY");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when OLLAMA_API_KEY is empty string", async () => {
    process.env.OLLAMA_API_KEY = "";
    await expect(ollamaWebSearch("test", undefined, mockFetch as FetchLike)).rejects.toThrow("OLLAMA_API_KEY");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns typed result when fetch returns 200", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    const result = await ollamaWebSearch("ollama", 3, mockFetch as FetchLike);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({ title: "T1", url: "https://a.com", content: "C1" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(OLLAMA_SEARCH_URL);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.query).toBe("ollama");
    expect(body.max_results).toBe(3);
  });

  it("throws when fetch returns 4xx", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    await expect(ollamaWebSearch("q", undefined, mockFetch as FetchLike)).rejects.toThrow(/401|Unauthorized/);
  });

  it("throws when fetch returns 5xx", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockFetch.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
    await expect(ollamaWebSearch("q", undefined, mockFetch as FetchLike)).rejects.toThrow(/500|Server/);
  });
});

describe("ollamaWebFetch", () => {
  const origKey = process.env.OLLAMA_API_KEY;
  const mockFetch = mock((url: string, _init?: RequestInit) => {
    if (url === OLLAMA_FETCH_URL) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            title: "Page Title",
            content: "Page content here",
            links: ["https://example.com"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });

  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.OLLAMA_API_KEY = origKey;
    else delete process.env.OLLAMA_API_KEY;
  });

  it("throws when OLLAMA_API_KEY is unset", async () => {
    delete process.env.OLLAMA_API_KEY;
    await expect(ollamaWebFetch("https://ollama.com", mockFetch as FetchLike)).rejects.toThrow("OLLAMA_API_KEY");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns typed result when fetch returns 200", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    const result = await ollamaWebFetch("https://ollama.com", mockFetch as FetchLike);
    expect(result.title).toBe("Page Title");
    expect(result.content).toBe("Page content here");
    expect(result.links).toEqual(["https://example.com"]);
    const body = JSON.parse((mockFetch.mock.calls[0][1]?.body as string) ?? "{}");
    expect(body.url).toBe("https://ollama.com");
  });

  it("throws when fetch returns 4xx", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    await expect(ollamaWebFetch("https://bad.url", mockFetch as FetchLike)).rejects.toThrow(/404|Not Found/);
  });
});
