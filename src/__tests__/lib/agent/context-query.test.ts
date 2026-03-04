/**
 * @fileoverview Tests for context-query helpers: extractSearchQueries, buildRawRetrievedContext,
 * filterRelevantSources, extractRelevantQuotes, cleanupQuotes, summarizeRetrievedContext, formatRecentThreadTurns.
 * @module __tests__/lib/agent/context-query
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  extractSearchQueries,
  extractSearchQueriesFromContextAndCommand,
  buildRawRetrievedContext,
  buildSmartContextBlock,
  rewriteCommandWithContext,
  type PriorResolvedCommand,
  filterRelevantSources,
  buildRawTextFromChunks,
  extractRelevantQuotes,
  extractRelevantSpansByKeyword,
  cleanupQuotes,
  summarizeRetrievedContext,
  countUserRounds,
  formatRecentThreadTurns,
  formatRoundsByIndex,
  buildRecentRoundDetail,
  transformContext,
  convertToLlm,
  buildContextAwareCommandsBlock,
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
      return {
        content: response,
        toolCalls: [],
        stopped: true,
      } satisfies AIResponse;
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
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const provider = makeProvider(
      '["Georgia filings", "Maia agent architecture"]',
    );
    const queries = await extractSearchQueries(
      ctx,
      () => provider,
      "What are the latest Georgia filings?",
    );
    expect(queries).toEqual(["Georgia filings", "Maia agent architecture"]);
  });

  it("trims and deduplicates queries", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const provider = makeProvider('["  foo  ", "bar", "foo"]');
    const queries = await extractSearchQueries(ctx, () => provider, "test");
    expect(queries).toEqual(["foo", "bar"]);
  });

  it("returns [userMessage] fallback when model response is not valid JSON", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const provider = makeProvider("Sorry, I cannot do that.");
    const queries = await extractSearchQueries(
      ctx,
      () => provider,
      "user message here",
    );
    expect(queries).toEqual(["user message here"]);
  });

  it("returns [userMessage] fallback when model response is JSON but not a string array", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const provider = makeProvider('{"queries": ["a"]}');
    const queries = await extractSearchQueries(
      ctx,
      () => provider,
      "fallback test",
    );
    expect(queries).toEqual(["fallback test"]);
  });

  it("returns [userMessage] fallback when provider throws", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const queries = await extractSearchQueries(
      ctx,
      () => makeErrorProvider(),
      "user input",
    );
    expect(queries).toEqual(["user input"]);
  });

  it("retries on 429 and returns model result when second call succeeds", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    let attempt = 0;
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        attempt++;
        if (attempt === 1) {
          throw new Error(
            'OpenRouter error 429: {"error":{"message":"Provider returned error","code":429}}',
          );
        }
        onToken('["retried query"]');
        return {
          content: '["retried query"]',
          toolCalls: [],
          stopped: true,
        } satisfies AIResponse;
      },
    };
    const queries = await extractSearchQueries(
      ctx,
      () => provider,
      "user input",
      undefined,
      { delayMs: 0 },
    );
    expect(queries).toEqual(["retried query"]);
    expect(attempt).toBe(2);
  });

  it("returns [userMessage] fallback when provider returns 429 on all retries", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const rateLimitProvider: AIProvider = {
      async complete() {
        throw new Error(
          'OpenRouter error 429: {"error":{"message":"Provider returned error","code":429}}',
        );
      },
    };
    const queries = await extractSearchQueries(
      ctx,
      () => rateLimitProvider,
      "user input",
      undefined,
      { delayMs: 0 },
    );
    expect(queries).toEqual(["user input"]);
  });

  it("filters out empty strings from parsed array and falls back if all are empty", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const provider = makeProvider('["", "  "]');
    const queries = await extractSearchQueries(ctx, () => provider, "fallback");
    expect(queries).toEqual(["fallback"]);
  });

  it("passes tools:[] to provider so it works without tool support", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
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

  it("includes clarified commands in user message when clarifiedCommandsContext is provided", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    let capturedUserContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const userMsg = messages.find((m) => m.role === "user");
        capturedUserContent = userMsg?.content ?? "";
        onToken('["topic a"]');
        return { content: '["topic a"]', toolCalls: [], stopped: true };
      },
    };
    await extractSearchQueries(
      ctx,
      () => provider,
      "current message",
      "Round 1: prior turn\nRound 2: prior reply",
    );
    expect(capturedUserContent).toContain("Clarified commands for this chat:");
    expect(capturedUserContent).toContain("prior turn");
    expect(capturedUserContent).toContain("prior reply");
    expect(capturedUserContent).toContain("Current user message:");
    expect(capturedUserContent).toContain("current message");
  });
});

// ─── extractSearchQueriesFromContextAndCommand ─────────────────────────────────

describe("extractSearchQueriesFromContextAndCommand", () => {
  it("returns fallback when providerFactory is undefined", async () => {
    const ctx = makeTestContext();
    const queries = await extractSearchQueriesFromContextAndCommand(
      ctx,
      undefined,
      "user asked about dashboard",
      "find past discussions",
    );
    expect(queries).toEqual([
      "find past discussions",
      "user asked about dashboard",
    ]);
  });

  it("parses valid JSON array from model", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const provider = makeProvider('["dashboard setup", "authentication flow"]');
    const queries = await extractSearchQueriesFromContextAndCommand(
      ctx,
      () => provider,
      "user asked about dashboard setup",
      "find relevant past discussions",
    );
    expect(queries).toEqual(["dashboard setup", "authentication flow"]);
  });

  it("returns fallback when model returns invalid JSON", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const provider = makeProvider("I cannot help with that.");
    const queries = await extractSearchQueriesFromContextAndCommand(
      ctx,
      () => provider,
      "context here",
      "command here",
    );
    expect(queries).toEqual(["command here", "context here"]);
  });
});

// ─── buildRawRetrievedContext ─────────────────────────────────────────────────

describe("buildRawRetrievedContext", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2", "ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
    });
    (
      ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }
    ).on(
      "/api/embed",
      async () =>
        new FakeResponse(200, JSON.stringify({ embeddings: [[0.9, 0.1]] })),
    );
  });

  it("returns text with history and knowledge sections", async () => {
    const store = createVectorStore(ctx.db);
    store.insertHistory(
      "hv1",
      "sess-1",
      "entry-1",
      "past conversation about GDPR",
      [0.9, 0.1],
      false,
      new Date().toISOString(),
    );
    store.upsertKnowledge(
      "kv1",
      "knowledge/law.md",
      "GDPR regulation content",
      "h1",
      [0.9, 0.1],
      new Date().toISOString(),
    );

    const { text, sources, contents } = await buildRawRetrievedContext(ctx, [
      "GDPR law",
    ]);

    expect(text).toContain("## History results");
    expect(text).toContain("past conversation about GDPR");
    expect(text).toContain("## Knowledge results");
    expect(text).toContain("GDPR regulation content");
    expect(sources.some((s) => s.type === "history")).toBe(true);
    expect(sources.some((s) => s.type === "knowledge")).toBe(true);
    expect(contents).toHaveLength(sources.length);
    expect(
      contents.some((c) => c.includes("past conversation about GDPR")),
    ).toBe(true);
    expect(contents.some((c) => c.includes("GDPR regulation content"))).toBe(
      true,
    );
    const rebuilt = buildRawTextFromChunks(sources, contents);
    expect(rebuilt).toBe(text);
  });

  it("deduplicates history results across multiple queries", async () => {
    const store = createVectorStore(ctx.db);
    store.insertHistory(
      "hv1",
      "sess-1",
      "entry-1",
      "unique content",
      [0.9, 0.1],
      false,
      new Date().toISOString(),
    );

    const { sources, contents } = await buildRawRetrievedContext(ctx, [
      "query one",
      "query two",
    ]);

    const histSources = sources.filter((s) => s.type === "history");
    const ids = histSources.map((s) => s.id);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(contents).toHaveLength(sources.length);
  });

  it("deduplicates knowledge results across multiple queries", async () => {
    const store = createVectorStore(ctx.db);
    store.upsertKnowledge(
      "kv1",
      "docs/report.md",
      "report content",
      "h1",
      [0.9, 0.1],
      new Date().toISOString(),
    );

    const { sources, contents } = await buildRawRetrievedContext(ctx, [
      "query a",
      "query b",
    ]);

    const knowledgeSources = sources.filter((s) => s.type === "knowledge");
    const ids = knowledgeSources.map((s) => s.id);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(contents).toHaveLength(sources.length);
  });

  it("returns no-results message when both searches return empty", async () => {
    const { text, sources, contents } = await buildRawRetrievedContext(ctx, [
      "unknown query",
    ]);
    expect(text).toContain("No relevant prior context found");
    expect(sources).toHaveLength(0);
    expect(contents).toHaveLength(0);
  });

  it("source ids follow the expected format", async () => {
    const store = createVectorStore(ctx.db);
    store.insertHistory(
      "hv1",
      "sess-1",
      "entry-1",
      "content",
      [0.9, 0.1],
      false,
      new Date().toISOString(),
    );
    store.upsertKnowledge(
      "kv1",
      "docs/file.md",
      "knowledge",
      "h1",
      [0.9, 0.1],
      new Date().toISOString(),
    );

    const { sources, contents } = await buildRawRetrievedContext(ctx, ["test"]);

    const histSrc = sources.find((s) => s.type === "history");
    const knowledgeSrc = sources.find((s) => s.type === "knowledge");
    expect(histSrc?.id).toMatch(/^history:/);
    expect(knowledgeSrc?.id).toMatch(/^knowledge:/);
    expect(contents).toHaveLength(sources.length);
  });
});

// ─── buildSmartContextBlock ────────────────────────────────────────────────────

describe("buildSmartContextBlock", () => {
  it("returns empty string when retrieval returns no results", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2", "ollama/nomic-embed-text"],
      contextQueryModel: "ollama/llama3.2",
      embeddingModel: "ollama/nomic-embed-text",
    });
    (
      ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }
    ).on(
      "/api/embed",
      async () =>
        new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.9]] })),
    );
    const provider = makeProvider('["user query topic"]');
    const result = await buildSmartContextBlock(
      ctx,
      () => provider,
      "What did we decide?",
    );
    expect(result.block).toBe("");
    expect(result.sourceIds).toEqual([]);
  });

  it("returns summarized block when retrieval has results", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2", "ollama/nomic-embed-text"],
      contextQueryModel: "ollama/llama3.2",
      contextSummaryModel: "ollama/llama3.2",
      embeddingModel: "ollama/nomic-embed-text",
    });
    (
      ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }
    ).on(
      "/api/embed",
      async () =>
        new FakeResponse(200, JSON.stringify({ embeddings: [[0.9, 0.1]] })),
    );
    const store = createVectorStore(ctx.db);
    store.insertHistory(
      "hv1",
      "sess-1",
      "entry-1",
      "We decided to use smart context.",
      [0.9, 0.1],
      false,
      new Date().toISOString(),
    );
    const responses = [
      '["decision", "outcome"]',
      '["history:sess-1/entry-1"]',
      "## Smart context\n\nWe decided to use smart context [history:sess-1/entry-1].",
    ];
    let idx = 0;
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        const out = responses[idx % responses.length] ?? "";
        idx++;
        onToken(out);
        return { content: out, toolCalls: [], stopped: true };
      },
    };
    const result = await buildSmartContextBlock(
      ctx,
      () => provider,
      "What did we decide?",
    );
    expect(result.block).toContain("## Smart context");
    expect(result.block).toContain("history:sess-1/entry-1");
    expect(result.sourceIds).toContain("history:sess-1/entry-1");
  });
});

// ─── rewriteCommandWithContext ───────────────────────────────────────────────────

describe("rewriteCommandWithContext", () => {
  it("returns model-resolved command and round index when JSON is valid", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const prior: PriorResolvedCommand[] = [
      { roundIndex: 1, resolvedCommand: "Scan repository for TODO comments" },
      { roundIndex: 2, resolvedCommand: "Open the README file" },
    ];
    const provider = makeProvider(
      JSON.stringify({
        roundIndex: 1,
        resolvedCommand:
          "Scan the repository for TODO comments again and summarize them.",
      }),
    );
    const result = await rewriteCommandWithContext(
      ctx,
      () => provider,
      prior,
      3,
      "Do that again and summarize it.",
      { delayMs: 0 },
    );
    expect(result.roundIndex).toBe(1);
    expect(result.resolvedCommand).toContain(
      "Scan the repository for TODO comments again",
    );
  });

  it("falls back to current round and raw message when model output is invalid", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const provider = makeProvider("this is not json at all");
    const result = await rewriteCommandWithContext(
      ctx,
      () => provider,
      [],
      5,
      "Original message",
      { delayMs: 0 },
    );
    expect(result.roundIndex).toBe(5);
    expect(result.resolvedCommand).toBe("Original message");
  });

  it("preserves narrative intent when model returns message with only reference clarified", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const narrative =
      "I have no particular plans at the moment, hence why I'll need a research division to generate and vet ideas and competition. A market analyst to figure out ways to profit off of each idea, etc.";
    const prior: PriorResolvedCommand[] = [];
    const provider = makeProvider(
      JSON.stringify({ roundIndex: 1, resolvedCommand: narrative }),
    );
    const result = await rewriteCommandWithContext(
      ctx,
      () => provider,
      prior,
      1,
      narrative,
      { delayMs: 0 },
    );
    expect(result.roundIndex).toBe(1);
    expect(result.resolvedCommand).toBe(narrative);
  });
});

// ─── filterRelevantSources ─────────────────────────────────────────────────────

describe("filterRelevantSources", () => {
  it("keeps only the sources whose ids are returned by the model", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const sources = [
      { type: "history" as const, id: "history:s1/e1" },
      { type: "knowledge" as const, id: "knowledge:doc1.md" },
    ];
    const contents = [
      "important history content",
      "unrelated knowledge content",
    ];
    const provider = makeProvider('["history:s1/e1"]');

    const { sources: filteredSources, contents: filteredContents } =
      await filterRelevantSources(
        ctx,
        () => provider,
        "question about prior conversation",
        sources,
        contents,
      );

    expect(filteredSources).toHaveLength(1);
    expect(filteredContents).toHaveLength(1);
    expect(filteredSources[0]?.id).toBe("history:s1/e1");
    expect(filteredContents[0]).toContain("important history content");
  });

  it("returns all sources unchanged when there is no query model configured", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "",
    });
    const sources = [
      { type: "history" as const, id: "history:s1/e1" },
      { type: "knowledge" as const, id: "knowledge:doc1.md" },
    ];
    const contents = ["content one", "content two"];
    const provider = makeErrorProvider();

    const { sources: filteredSources, contents: filteredContents } =
      await filterRelevantSources(
        ctx,
        () => provider,
        "any question",
        sources,
        contents,
      );

    expect(filteredSources).toEqual(sources);
    expect(filteredContents).toEqual(contents);
  });

  it("returns all sources unchanged when the model response cannot be parsed as a JSON array", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const sources = [
      { type: "history" as const, id: "history:s1/e1" },
      { type: "knowledge" as const, id: "knowledge:doc1.md" },
    ];
    const contents = ["first content", "second content"];
    const provider = makeProvider("this is not json");

    const { sources: filteredSources, contents: filteredContents } =
      await filterRelevantSources(
        ctx,
        () => provider,
        "question text",
        sources,
        contents,
      );

    expect(filteredSources).toEqual(sources);
    expect(filteredContents).toEqual(contents);
  });

  it("returns no sources when the model returns an empty array", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const sources = [
      { type: "history" as const, id: "history:s1/e1" },
      { type: "knowledge" as const, id: "knowledge:doc1.md" },
    ];
    const contents = ["first content", "second content"];
    const provider = makeProvider("[]");

    const { sources: filteredSources, contents: filteredContents } =
      await filterRelevantSources(
        ctx,
        () => provider,
        "question text",
        sources,
        contents,
      );

    expect(filteredSources).toHaveLength(0);
    expect(filteredContents).toHaveLength(0);
  });

  it("retries on 429 and uses the ids from the successful retry", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const sources = [
      { type: "history" as const, id: "history:s1/e1" },
      { type: "knowledge" as const, id: "knowledge:doc1.md" },
    ];
    const contents = ["first content", "second content"];
    let attempt = 0;
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        attempt++;
        if (attempt === 1) {
          throw new Error(
            'OpenRouter error 429: {"error":{"message":"Provider returned error","code":429}}',
          );
        }
        const content = '["knowledge:doc1.md"]';
        onToken(content);
        return { content, toolCalls: [], stopped: true } satisfies AIResponse;
      },
    };

    const { sources: filteredSources, contents: filteredContents } =
      await filterRelevantSources(
        ctx,
        () => provider,
        "question text",
        sources,
        contents,
        { delayMs: 0 },
      );

    expect(attempt).toBe(2);
    expect(filteredSources).toHaveLength(1);
    expect(filteredSources[0]?.id).toBe("knowledge:doc1.md");
    expect(filteredContents).toHaveLength(1);
    expect(filteredContents[0]).toContain("second content");
  });
});

// ─── cleanupQuotes ────────────────────────────────────────────────────────────

describe("cleanupQuotes", () => {
  it("deduplicates when one snippet is substring of another", () => {
    const quotes = [
      { sourceId: "history:s1/e1", text: "short" },
      { sourceId: "history:s1/e1", text: "short and longer context" },
    ];
    const content = "Before. short and longer context. After.";
    const map = new Map<string, string>([["history:s1/e1", content]]);
    const result = cleanupQuotes(quotes, map);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toContain("short and longer context");
  });

  it("extends snippet to sentence boundary when found in source", () => {
    const content = "First sentence. Relevant part here. Last sentence.";
    const quotes = [
      { sourceId: "knowledge:doc.md", text: "Relevant part here" },
    ];
    const map = new Map<string, string>([["knowledge:doc.md", content]]);
    const result = cleanupQuotes(quotes, map);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toContain("Relevant part here");
    expect(result[0]?.text).toMatch(/\.\s/);
  });

  it("leaves snippet as-is when not found in source", () => {
    const quotes = [{ sourceId: "history:s1/e1", text: "not in source" }];
    const map = new Map<string, string>([
      ["history:s1/e1", "different content"],
    ]);
    const result = cleanupQuotes(quotes, map);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("not in source");
  });
});

// ─── extractRelevantSpansByKeyword ────────────────────────────────────────────

describe("extractRelevantSpansByKeyword", () => {
  it("returns spans that contain keywords from user message", () => {
    const sources = [{ type: "history" as const, id: "history:s1/e1" }];
    const contents = [
      "First paragraph.\n\nSecond paragraph has deployment and config.\n\nThird is unrelated.",
    ];
    const spans = extractRelevantSpansByKeyword(
      "deployment config",
      [],
      sources,
      contents,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].sourceId).toBe("history:s1/e1");
    expect(spans[0].text).toContain("deployment");
    expect(spans[0].text).toContain("config");
  });

  it("returns spans that contain keywords from search queries", () => {
    const sources = [{ type: "knowledge" as const, id: "knowledge:doc.md" }];
    const contents = ["Intro.\n\nSection about GDPR and compliance.\n\nEnd."];
    const spans = extractRelevantSpansByKeyword(
      "",
      ["GDPR", "compliance"],
      sources,
      contents,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toContain("GDPR");
  });

  it("returns empty when no keyword match", () => {
    const sources = [{ type: "knowledge" as const, id: "knowledge:x.md" }];
    const contents = ["Only unrelated content here."];
    const spans = extractRelevantSpansByKeyword(
      "deployment",
      [],
      sources,
      contents,
    );
    expect(spans).toHaveLength(0);
  });

  it("splits long paragraphs into matching sentences", () => {
    const sources = [{ type: "knowledge" as const, id: "knowledge:long.md" }];
    const sentence = "This sentence has the keyword. ".repeat(30);
    const contents = [`No match here. ${sentence} No match at end.`];
    const spans = extractRelevantSpansByKeyword(
      "keyword",
      [],
      sources,
      contents,
    );
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((s) => s.text.includes("keyword"))).toBe(true);
  });
});

// ─── extractRelevantQuotes ────────────────────────────────────────────────────

describe("extractRelevantQuotes", () => {
  it("returns quotes with sourceId from model JSON array of text", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextSummaryModel: "ollama/llama3.2",
    });
    const provider = makeProvider(
      '[{"text": "verbatim snippet one"}, {"text": "snippet two"}]',
    );
    const sources = [{ type: "history" as const, id: "history:s1/e1" }];
    const contents = ["full content with verbatim snippet one and snippet two"];
    const quotes = await extractRelevantQuotes(
      ctx,
      () => provider,
      "user query",
      sources,
      contents,
    );
    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toEqual({
      sourceId: "history:s1/e1",
      text: "verbatim snippet one",
    });
    expect(quotes[1]).toEqual({
      sourceId: "history:s1/e1",
      text: "snippet two",
    });
  });

  it("returns empty array when no model configured and falls back to no quotes", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextSummaryModel: "",
      contextQueryModel: "",
    });
    const sources = [{ type: "history" as const, id: "history:s1/e1" }];
    const contents = ["content"];
    const quotes = await extractRelevantQuotes(
      ctx,
      () => makeErrorProvider(),
      "query",
      sources,
      contents,
    );
    expect(quotes).toHaveLength(0);
  });

  it("falls back to empty when model returns invalid JSON", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextSummaryModel: "ollama/llama3.2",
    });
    const provider = makeProvider("not json");
    const sources = [{ type: "knowledge" as const, id: "knowledge:doc.md" }];
    const contents = ["doc content"];
    const quotes = await extractRelevantQuotes(
      ctx,
      () => provider,
      "query",
      sources,
      contents,
    );
    expect(quotes).toHaveLength(0);
  });
});

// ─── summarizeRetrievedContext ────────────────────────────────────────────────

describe("summarizeRetrievedContext", () => {
  it("returns the model output as the summary when contents not provided", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const provider = makeProvider(
      "## Smart context\nSummary with [history:sess/entry] and [knowledge:law.md].",
    );
    const sources = [
      { type: "history" as const, id: "history:sess/entry" },
      { type: "knowledge" as const, id: "knowledge:law.md" },
    ];
    const result = await summarizeRetrievedContext(
      ctx,
      () => provider,
      "raw context text",
      sources,
    );
    const block = typeof result === "string" ? result : result.block;
    expect(block).toContain("## Smart context");
    expect(block).toContain("[history:sess/entry]");
  });

  it("passes tools:[] to provider", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
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
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const result = await summarizeRetrievedContext(
      ctx,
      () => makeErrorProvider(),
      "the raw context",
      [],
    );
    const block = typeof result === "string" ? result : result.block;
    expect(block).toContain("the raw context");
  });

  it("retries on 429 and returns summary when second call succeeds", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    let attempt = 0;
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        attempt++;
        if (attempt === 1) {
          throw new Error(
            'OpenRouter error 429: {"error":{"message":"Provider returned error","code":429}}',
          );
        }
        onToken("## Smart context\nSummarized.");
        return {
          content: "## Smart context\nSummarized.",
          toolCalls: [],
          stopped: true,
        } satisfies AIResponse;
      },
    };
    const result = await summarizeRetrievedContext(
      ctx,
      () => provider,
      "the raw context",
      [],
      {
        retryOptions: { delayMs: 0 },
      },
    );
    const block = typeof result === "string" ? result : result.block;
    expect(block).toContain("Summarized.");
    expect(attempt).toBe(2);
  });

  it("falls back to raw context when provider returns 429 on all retries", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2"],
      contextQueryModel: "ollama/llama3.2",
    });
    const rateLimitProvider: AIProvider = {
      async complete() {
        throw new Error(
          'OpenRouter error 429: {"error":{"message":"Provider returned error","code":429}}',
        );
      },
    };
    const result = await summarizeRetrievedContext(
      ctx,
      () => rateLimitProvider,
      "the raw context",
      [],
      {
        retryOptions: { delayMs: 0 },
      },
    );
    const block = typeof result === "string" ? result : result.block;
    expect(block).toContain("the raw context");
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

  it("when contents provided uses keyword span extraction and returns focused-quote block and quotes array", async () => {
    const ctx = makeTestContext();
    const sources = [{ type: "knowledge" as const, id: "knowledge:doc.md" }];
    const contents = ["exact quote from source"];
    const result = await summarizeRetrievedContext(
      ctx,
      () => makeProvider("unused"),
      "raw",
      sources,
      {
        contents,
        userMessage: "find quote from source",
        searchQueries: ["exact quote"],
      },
    );
    expect(typeof result).toBe("object");
    expect("block" in result && "quotes" in result).toBe(true);
    const { block, quotes } = result as {
      block: string;
      quotes: Array<{ sourceId: string; text: string }>;
    };
    expect(block).toContain("## Smart context");
    expect(block).toContain("exact quote from source");
    expect(block).toContain("### Quoted sources");
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toEqual({
      sourceId: "knowledge:doc.md",
      text: expect.stringContaining("exact quote"),
    });
  });
});

// ─── countUserRounds ───────────────────────────────────────────────────────────

describe("countUserRounds", () => {
  it("returns the number of user entries in the session", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "a", timestamp: ts },
      { id: "e2", role: "agent", content: "b", timestamp: ts },
      { id: "e3", role: "user", content: "c", timestamp: ts },
    ]);
    expect(countUserRounds(session)).toBe(2);
  });

  it("returns 0 for empty session", () => {
    const session = makeSession([]);
    expect(countUserRounds(session)).toBe(0);
  });

  it("does not count thinking or tool_call as rounds", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "a", timestamp: ts },
      { id: "e2", role: "thinking", content: "reasoning", timestamp: ts },
      {
        id: "e3",
        role: "tool_call",
        content: "x",
        toolName: "t",
        timestamp: ts,
      },
    ]);
    expect(countUserRounds(session)).toBe(1);
  });
});

// ─── buildContextAwareCommandsBlock ─────────────────────────────────────────────

describe("buildContextAwareCommandsBlock", () => {
  it("returns a list of rounds with resolved commands", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      {
        id: "e1",
        role: "user",
        content: "raw 1",
        resolvedContent: "resolved 1",
        roundIndex: 1,
        timestamp: ts,
      },
      { id: "e2", role: "agent", content: "reply", timestamp: ts },
      {
        id: "e3",
        role: "user",
        content: "raw 2",
        resolvedContent: "resolved 2",
        roundIndex: 2,
        timestamp: ts,
      },
    ]);
    const block = buildContextAwareCommandsBlock(session);
    expect(block).toContain("## Context-aware commands");
    expect(block).toContain("Round 1: resolved 1");
    expect(block).toContain("Round 2: resolved 2");
  });

  it("falls back to content and inferred round index when metadata missing", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "only raw", timestamp: ts },
    ]);
    const block = buildContextAwareCommandsBlock(session);
    expect(block).toContain("Round 1: only raw");
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
      {
        id: "e1",
        role: "user",
        content: "search for something",
        timestamp: ts,
      },
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

  it("when skipThinking true, omits thinking entries from output", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "user msg", timestamp: ts },
      {
        id: "e2",
        role: "thinking",
        content: "internal reasoning",
        timestamp: ts,
      },
      { id: "e3", role: "agent", content: "agent reply", timestamp: ts },
    ]);
    const result = formatRecentThreadTurns(session, 2, { skipThinking: true });
    expect(result).toContain("user msg");
    expect(result).toContain("agent reply");
    expect(result).not.toContain("internal reasoning");
    expect(result).not.toContain("Reasoning:");
  });
});

// ─── formatRoundsByIndex & buildRecentRoundDetail ─────────────────────────────

describe("formatRoundsByIndex", () => {
  it("returns full context for requested 1-based round indices", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "first", timestamp: ts },
      { id: "e2", role: "agent", content: "reply one", timestamp: ts },
      { id: "e3", role: "user", content: "second", timestamp: ts },
      { id: "e4", role: "agent", content: "reply two", timestamp: ts },
    ]);
    const result = formatRoundsByIndex(session, [1]);
    expect(result).toContain("## Chat read");
    expect(result).toContain("### Round 1");
    expect(result).toContain("first");
    expect(result).toContain("reply one");
    expect(result).not.toContain("second");
  });

  it("returns multiple requested rounds in order", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "a", timestamp: ts },
      { id: "e2", role: "agent", content: "b", timestamp: ts },
      { id: "e3", role: "user", content: "c", timestamp: ts },
      { id: "e4", role: "agent", content: "d", timestamp: ts },
    ]);
    const result = formatRoundsByIndex(session, [2, 1]);
    expect(result).toContain("### Round 1");
    expect(result).toContain("### Round 2");
    expect(result).toContain("a");
    expect(result).toContain("c");
  });
});

describe("buildRecentRoundDetail", () => {
  it("returns tool calls and agent excerpt after last user message", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "run dev", timestamp: ts },
      {
        id: "e2",
        role: "tool_call",
        content: "output",
        toolName: "terminal_exec",
        toolArgs: { command: "bun run dev" },
        timestamp: ts,
      },
      { id: "e3", role: "agent", content: "Done.", timestamp: ts },
    ]);
    const result = buildRecentRoundDetail(session);
    expect(result).toContain("terminal_exec");
    expect(result).toContain("bun run dev");
    expect(result).toContain("Done.");
  });

  it("returns empty string when no entries after last user", () => {
    const ts = new Date().toISOString();
    const session = makeSession([
      { id: "e1", role: "user", content: "only user", timestamp: ts },
    ]);
    expect(buildRecentRoundDetail(session)).toBe("");
  });
});

// ─── transformContext & convertToLlm (context pipeline) ─────────────────────

describe("transformContext", () => {
  it("joins recent thread, smart context, and system prompt with separator", () => {
    const recent = "## Recent thread\n\nNo recent turns.";
    const smart = "## Smart context\n\nSummary.";
    const system = "You are helpful.";
    const result = transformContext(recent, smart, system);
    expect(result).toContain("## Recent thread");
    expect(result).toContain("## Smart context");
    expect(result).toContain("You are helpful.");
    expect(result).toMatch(/\n\n---\n\n/);
  });

  it("omits smart context when empty", () => {
    const recent = "## Recent thread\n\nNo recent turns.";
    const system = "You are helpful.";
    const result = transformContext(recent, "", system);
    expect(result).toBe(
      "## Recent thread\n\nNo recent turns.\n\n---\n\nYou are helpful.",
    );
  });
});

describe("convertToLlm", () => {
  it("returns system and user messages when no initial tool result", () => {
    const messages = convertToLlm("System content", "Hello");
    expect(messages).toEqual([
      { role: "system", content: "System content" },
      { role: "user", content: "Hello" },
    ]);
  });

  it("appends tool message when initialToolResult is provided", () => {
    const messages = convertToLlm("System", "Hi", {
      content: "tool output",
      toolName: "my_tool",
    });
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "tool",
      content: "tool output",
      toolCallId: "cron-initial",
      toolName: "my_tool",
    });
  });
});
