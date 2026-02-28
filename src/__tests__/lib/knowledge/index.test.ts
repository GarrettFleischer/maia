/**
 * @fileoverview Tests for knowledge base index (scan, hash, upsert/delete).
 * @module __tests__/lib/knowledge/index
 */
import path from "path";
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext, FakeHttp, FakeResponse } from "@/__tests__/helpers/fakes";
import { runKnowledgeIndex, KNOWLEDGE_DIR } from "@/lib/knowledge/index";
import { createVectorStore } from "@/lib/knowledge/vector-store";
import { _clearOllamaEmbedContextLengthCacheForTests } from "@/lib/knowledge/embedding";
import type { AppContext } from "@/lib/context";
import type { EmbeddingAdapter } from "@/lib/knowledge/embedding";

describe("knowledge index", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
    _clearOllamaEmbedContextLengthCacheForTests();
  });

  it("creates knowledge dir and returns 0 indexed when dir empty", async () => {
    const result = await runKnowledgeIndex(ctx, {});
    expect(result.indexed).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("indexes markdown files when embedder provided", async () => {
    const fakeEmbedder: EmbeddingAdapter = {
      embed: async () => [0.1, 0.2, 0.3],
    };
    ctx.fs.mkdirp(KNOWLEDGE_DIR);
    ctx.fs.writeFile(path.join(KNOWLEDGE_DIR, "report.md"), "# Report\n\nContent here.");

    const result = await runKnowledgeIndex(ctx, { embedder: fakeEmbedder });
    expect(result.indexed).toBe(1);
    expect(result.removed).toBe(0);

    const store = createVectorStore(ctx.db);
    const paths = store.getAllKnowledgePaths();
    expect(paths).toContain("report.md");
  });

  it("skips unchanged files (same hash)", async () => {
    const embedCalls: string[] = [];
    const fakeEmbedder: EmbeddingAdapter = {
      embed: async (text) => {
        embedCalls.push(text);
        return [0.1, 0.2];
      },
    };
    ctx.fs.mkdirp(KNOWLEDGE_DIR);
    ctx.fs.writeFile(path.join(KNOWLEDGE_DIR, "same.md"), "unchanged");

    await runKnowledgeIndex(ctx, { embedder: fakeEmbedder });
    expect(embedCalls).toHaveLength(1);
    embedCalls.length = 0;

    await runKnowledgeIndex(ctx, { embedder: fakeEmbedder });
    expect(embedCalls).toHaveLength(0);
  });

  it("removes vector when file deleted from disk", async () => {
    const fakeEmbedder: EmbeddingAdapter = { embed: async () => [0.1] };
    ctx.fs.mkdirp(KNOWLEDGE_DIR);
    ctx.fs.writeFile(path.join(KNOWLEDGE_DIR, "gone.md"), "content");
    await runKnowledgeIndex(ctx, { embedder: fakeEmbedder });

    ctx.fs.deleteFile(path.join(KNOWLEDGE_DIR, "gone.md"));
    const result = await runKnowledgeIndex(ctx, {});
    expect(result.removed).toBe(1);
    const store = createVectorStore(ctx.db);
    expect(store.getAllKnowledgePaths()).not.toContain("gone.md");
  });

  it("truncates content to effective embed limit when embedMaxContentLength exceeds model limit", async () => {
    const embedCalls: string[] = [];
    const fakeEmbedder: EmbeddingAdapter = {
      embed: async (text) => {
        embedCalls.push(text);
        return [0.1, 0.2];
      },
    };
    ctx.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("embedMaxContentLength", "32000");
    const http = new FakeHttp();
    http.on("/api/show", async () =>
      new FakeResponse(200, JSON.stringify({ parameters: "num_ctx 2048\n" }))
    );
    ctx = { ...ctx, http };
    ctx.fs.mkdirp(KNOWLEDGE_DIR);
    const longContent = "x".repeat(10000);
    ctx.fs.writeFile(path.join(KNOWLEDGE_DIR, "long.md"), longContent);

    await runKnowledgeIndex(ctx, { embedder: fakeEmbedder });

    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0].length).toBe(4096);
    expect(embedCalls[0]).toBe("x".repeat(4096));
  });
});
