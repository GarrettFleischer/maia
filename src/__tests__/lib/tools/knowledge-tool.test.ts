/**
 * @fileoverview Tests for knowledge_search and history_semantic_search tools.
 * @module __tests__/lib/tools/knowledge-tool
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext, FakeResponse } from "@/__tests__/helpers/fakes";
import { knowledgeSearchTool, historySemanticSearchTool } from "@/lib/tools/knowledge-tool";
import { createVectorStore } from "@/lib/knowledge/vector-store";
import type { AppContext } from "@/lib/context";

describe("knowledge_search tool", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
    (ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async () => new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }))
    );
  });

  it("returns expected shape and respects limit", async () => {
    const store = createVectorStore(ctx.db);
    store.upsertKnowledge(
      "id1",
      "report.md",
      "Annual report content",
      "h1",
      [0.1, 0.2, 0.3],
      new Date().toISOString()
    );

    const toolCtx = { ...ctx, agentId: "maia", sessionId: "s1", volumeRoot: "/tmp/ws" };
    const result = await knowledgeSearchTool.execute(
      { query: "annual report", limit: 2 },
      toolCtx
    );

    expect(Array.isArray(result)).toBe(true);
    expect((result as { path: string; content: string; score: number }[]).length).toBeLessThanOrEqual(2);
    if ((result as unknown[]).length > 0) {
      const first = (result as { path: string; content: string; score: number }[])[0];
      expect(first).toHaveProperty("path");
      expect(first).toHaveProperty("content");
      expect(first).toHaveProperty("score");
    }
  });
});

describe("history_semantic_search tool", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
    (ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async () => new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] }))
    );
  });

  it("returns expected shape", async () => {
    const store = createVectorStore(ctx.db);
    store.insertHistory("h1", "s1", "e1", "past message", [0.1, 0.2], false, new Date().toISOString());

    const toolCtx = { ...ctx, agentId: "maia", sessionId: "s1", volumeRoot: "/tmp/ws" };
    const result = await historySemanticSearchTool.execute(
      { query: "past message", limit: 5 },
      toolCtx
    );

    expect(Array.isArray(result)).toBe(true);
    if ((result as unknown[]).length > 0) {
      const first = (result as { sessionId: string; content: string; score: number }[])[0];
      expect(first).toHaveProperty("sessionId");
      expect(first).toHaveProperty("content");
      expect(first).toHaveProperty("score");
    }
  });
});
