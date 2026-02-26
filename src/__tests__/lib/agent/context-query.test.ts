/**
 * @fileoverview Tests for context-query helpers: extractSearchQueries, buildRawRetrievedContext, summarizeRetrievedContext, formatRecentThreadTurns.
 * @module __tests__/lib/agent/context-query
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  extractSearchQueries,
  buildRawRetrievedContext,
  summarizeRetrievedContext,
  formatRecentThreadTurns,
} from "@/lib/agent/context-query";
import { makeTestContext, FakeResponse } from "@/__tests__/helpers/fakes";
import { createVectorStore } from "@/lib/knowledge/vector-store";
import { updateSettings } from "@/lib/settings";
import type { AppContext } from "@/lib/context";
import type { AIProvider, AIResponse } from "@/lib/ai/types";
import type { Session } from "@/lib/types";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeProvider(response: string): AIProvider {
  return {
    async complete(_messages, _tools, onToken) {
      onToken(response);
      return { content: response, toolCalls: [], stopped: true } satisfies AIResponse;
    },
  };
}

function makeErrorProvider(): AIProvider {
  return {
    async complete() {
      throw new Error("provider failure");
    },
  };
}

function makeSession(entries: Session["original"]): Session {
  return {
    id: "s1",
    name: "",
    description: "",
    participants: ["user", "maia"],
    tags: [],
    type: "user",
    original: entries,
    compressed: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ─── extractSearchQueries ────────────────────────────────────────────────────

describe("extractSearchQueries", () => {
  it("parses a valid JSON array of search queries from the model response", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"], contextQueryModel: "ollama/llama3.2" });
    const provider = makeProvider('["Georgia filings", "Maia agent architecture"]');
    const queries = await extractSearchQueries(ctx, () => provider, "What are the latest Georgia filings?");
    expect(queries).toEqual(["Georgia filings", "Maia agent architecture"]);
  });

  it("trims and deduplicates queries", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"], contextQueryModel: "ollama/llama3.2" });
    const provider = makeProvider('["  foo  ", "bar", "foo"]');
    const queries = await extractSearchQueries(ctx, () => provider, "test");
    expect(queries).toEqual(["foo", "bar"]);
  });

  it("returns [userMessage] fallback when model response is not valid JSON", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"], contextQueryModel: "ollama/llama3.2" });
    const provider = makeProvider("Sorry, I cannot do that.");
    const queries = await extractSearchQueries(ctx, () => provider, "user message here");
    expect(queries).toEqual(["user message here"]);
  });

  it("returns [userMessage] fallback when model response is JSON but not a string array", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"], contextQueryModel: "ollama/llama3.2" });
    const provider = makeProvider('{"queries": ["a"]}');
    const queries = await extractSearchQueries(ctx, () => provider, "fallback test");
    expect(queries).toEqual(["fallback test"]);
  });

  it("returns [userMessage] fallback when provider throws", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"], contextQueryModel: "ollama/llama3.2" });
    const queries = await extractSearchQueries(ctx, () => makeErrorProvider(), "user input");
    expect(queries).toEqual(["user input"]);
  });

  it("filters out empty strings from parsed array and falls back if all are empty", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"], contextQueryModel: "ollama/llama3.2" });
    const provider = makeProvider('["", "  "]');
    const queries = await extractSearchQueries(ctx, () => provider, "fallback");
    expect(queries).toEqual(["fallback"]);
  });

  it("passes tools:[] to provider so it works without tool support", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"], contextQueryModel: "ollama/llama3.2" });
    let capturedTools: unknown[] = ["sentinel"];
    const provider: AIProvider = {
      async complete(_messages, tools, onToken) {
        capturedTools = tools;
        onToken('["q1"]');
        return { content: '["q1"]', toolCalls: [], stopped: true };
      },
    };
    await extractSearchQueries(ctx, () => provider, "test");
    expect(capturedTools).toEqual([]);
  });
});

// ─── buildRawRetrievedContext ─────────────────────────────────────────────────

describe("buildRawRetrievedContext", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      embeddingModel: "nomic-embed-text",
    });
    (ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async () => new FakeResponse(200, JSON.stringify({ embeddings: [[0.9, 0.1]] }))
    );
  });

  it("returns text with history and knowledge sections", async () => {
    const store = createVectorStore(ctx.db);
    store.insertHistory("hv1", "sess-1", "entry-1", "past conversation about GDPR", [0.9, 0.1], false, new Date().toISOString());
    store.upsertKnowledge("kv1", "knowledge/law.md", "GDPR regulation content", "h1", [0.9, 0.1], new Date().toISOString());

    const { text, sources } = await buildRawRetrievedContext(ctx, ["GDPR law"]);

    expect(text).toContain("## History results");
    expect(text).toContain("past conversation about GDPR");
    expect(text).toContain("## Knowledge results");
    expect(text).toContain("GDPR regulation content");
    expect(sources.some((s) => s.type === "history")).toBe(true);
    expect(sources.some((s) => s.type === "knowledge")).toBe(true);
  });

  it("deduplicates history results across multiple queries", async () => {
    const store = createVectorStore(ctx.db);
    store.insertHistory("hv1", "sess-1", "entry-1", "unique content", [0.9, 0.1], false, new Date().toISOString());

    const { sources } = await buildRawRetrievedContext(ctx, ["query one", "query two"]);

    const histSources = sources.filter((s) => s.type === "history");
    const ids = histSources.map((s) => s.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it("deduplicates knowledge results across multiple queries", async () => {
    const store = createVectorStore(ctx.db);
    store.upsertKnowledge("kv1", "docs/report.md", "report content", "h1", [0.9, 0.1], new Date().toISOString());

    const { sources } = await buildRawRetrievedContext(ctx, ["query a", "query b"]);

    const knowledgeSources = sources.filter((s) => s.type === "knowledge");
    const ids = knowledgeSources.map((s) => s.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it("returns no-results message when both searches return empty", async () => {
    const { text, sources } = await buildRawRetrievedContext(ctx, ["unknown query"]);
    expect(text).toContain("No relevant prior context found");
    expect(sources).toHaveLength(0);
  });

  it("source ids follow the expected format", async () => {
    const store = createVectorStore(ctx.db);
    store.insertHistory("hv1", "sess-1", "entry-1", "content", [0.9, 0.1], false, new Date().toISOString());
    store.upsertKnowledge("kv1", "docs/file.md", "knowledge", "h1", [0.9, 0.1], new Date().toISOString());

    const { sources } = await buildRawRetrievedContext(ctx, ["test"]);

    const histSrc = sources.find((s) => s.type === "history");
    const knowledgeSrc = sources.find((s) => s.type === "knowledge");
    expect(histSrc?.id).toMatch(/^history:/);
    expect(knowledgeSrc?.id).toMatch(/^knowledge:/);
  });
});

// ─── summarizeRetrievedContext ────────────────────────────────────────────────

describe("summarizeRetrievedContext", () => {
  it("returns the model output as the summary", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"], contextQueryModel: "ollama/llama3.2" });
    const provider = makeProvider("## Smart context\nSummary with [history:sess/entry] and [knowledge:law.md].");
    const sources = [
      { type: "history" as const, id: "history:sess/entry" },
      { type: "knowledge" as const, id: "knowledge:law.md" },
    ];
    const result = await summarizeRetrievedContext(ctx, () => provider, "raw context text", sources);
    expect(result).toContain("## Smart context");
    expect(result).toContain("[history:sess/entry]");
  });

  it("passes tools:[] to provider", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"], contextQueryModel: "ollama/llama3.2" });
    let capturedTools: unknown[] = ["sentinel"];
    const provider: AIProvider = {
      async complete(_messages, tools, onToken) {
        capturedTools = tools;
        onToken("summary");
        return { content: "summary", toolCalls: [], stopped: true };
      },
    };
    await summarizeRetrievedContext(ctx, () => provider, "raw", []);
    expect(capturedTools).toEqual([]);
  });

  it("falls back to raw context text on provider failure", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"], contextQueryModel: "ollama/llama3.2" });
    const result = await summarizeRetrievedContext(ctx, () => makeErrorProvider(), "the raw context", []);
    expect(result).toContain("the raw context");
  });

  it("uses contextSummaryModel when set, contextQueryModel as fallback", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2", "ollama/qwen2.5"],
      contextQueryModel: "ollama/llama3.2",
      contextSummaryModel: "ollama/qwen2.5",
    });
    const calledModels: string[] = [];
    const providerFactory = (model: string): AIProvider => {
      calledModels.push(model);
      return makeProvider("summary output");
    };
    await summarizeRetrievedContext(ctx, providerFactory, "raw", []);
    expect(calledModels[0]).toBe("ollama/qwen2.5");
  });

  it("uses contextQueryModel when contextSummaryModel is empty", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
      contextSummaryModel: "",
    });
    const calledModels: string[] = [];
    const providerFactory = (model: string): AIProvider => {
      calledModels.push(model);
      return makeProvider("summary");
    };
    await summarizeRetrievedContext(ctx, providerFactory, "raw", []);
    expect(calledModels[0]).toBe("ollama/llama3.2");
  });
});

// ─── formatRecentThreadTurns ──────────────────────────────────────────────────

describe("formatRecentThreadTurns", () => {
  it("returns the last N turns from the session", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "first", timestamp: ts },
      { id: "e2", role: "agent", content: "reply one", timestamp: ts },
      { id: "e3", role: "user", content: "second", timestamp: ts },
      { id: "e4", role: "agent", content: "reply two", timestamp: ts },
      { id: "e5", role: "user", content: "third", timestamp: ts },
    ]);
    const result = formatRecentThreadTurns(session, 2);
    expect(result).toContain("third");
    expect(result).toContain("reply two");
    expect(result).not.toContain("first");
    expect(result).not.toContain("reply one");
  });

  it("includes tool args and results for tool_call entries", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "search for something", timestamp: ts },
      {
        id: "e2",
        role: "tool_call",
        content: "search results here",
        toolName: "knowledge_search",
        toolArgs: { query: "something" },
        timestamp: ts,
      },
    ]);
    const result = formatRecentThreadTurns(session, 3);
    expect(result).toContain("knowledge_search");
    expect(result).toContain("something");
    expect(result).toContain("search results here");
  });

  it("includes all entries when session has fewer than N turns", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "only turn", timestamp: ts },
    ]);
    const result = formatRecentThreadTurns(session, 5);
    expect(result).toContain("only turn");
  });

  it("returns a section heading with the recent turn count", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "msg", timestamp: ts },
    ]);
    const result = formatRecentThreadTurns(session, 3);
    expect(result).toContain("## Recent thread");
  });

  it("returns a no-turns message for an empty session", () => {
    const session = makeSession([]);
    const result = formatRecentThreadTurns(session, 3);
    expect(result).toContain("## Recent thread");
    expect(result).toContain("No recent turns");
  });
});
