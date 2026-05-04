/**
 * @fileoverview Tests for knowledge base index (SQLite knowledge_vectors).
 * @module __tests__/lib/knowledge/index
 */
import path from "path";
import { describe, it, expect, beforeEach } from "bun:test";
import {
  makeTestContext,
  FakeHttp,
  FakeResponse,
} from "@/__tests__/helpers/fakes";
import { runKnowledgeIndex, DATA_DIR } from "@/lib/knowledge/index";
import { _clearOllamaEmbedContextLengthCacheForTests } from "@/lib/knowledge/embedding";
import { writeModelsConfig } from "@/lib/models-config";
import type { AppContext } from "@/lib/context";

function seedEmbeddingSettings(ctx: AppContext): FakeHttp {
  writeModelsConfig([{ provider: "ollama", name: "nomic-embed-text" }]);
  ctx.db
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run("embeddingModel", "ollama/nomic-embed-text");
  const http = new FakeHttp();
  http.on(
    "/api/show",
    async () =>
      new FakeResponse(200, JSON.stringify({ parameters: "num_ctx 8192" })),
  );
  http.on("/api/embed", async (_url, init) => {
    const body =
      init?.body && typeof init.body === "string"
        ? (JSON.parse(init.body) as { input: string[] })
        : { input: [] as string[] };
    const embeddings = body.input.map(() => [0.1, 0.2]);
    return new FakeResponse(200, JSON.stringify({ embeddings }));
  });
  return http;
}

describe("knowledge index", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("returns 0 indexed when data dir missing (creates empty dir)", async () => {
    const result = await runKnowledgeIndex(ctx, {});
    expect(result.indexed).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("indexes markdown files into knowledge_vectors", async () => {
    const http = seedEmbeddingSettings(ctx);
    ctx = { ...ctx, http };
    ctx.fs.mkdirp(DATA_DIR);
    ctx.fs.writeFile(
      path.join(DATA_DIR, "report.md"),
      "# Report\n\nContent here.",
    );

    const result = await runKnowledgeIndex(ctx, {});
    expect(result.indexed).toBe(1);
    expect(result.removed).toBe(0);
    const row = ctx.db
      .prepare("SELECT path, content FROM knowledge_vectors WHERE path = ?")
      .get("report.md") as { path: string; content: string } | undefined;
    expect(row?.path).toBe("report.md");
    expect(row?.content.trim()).toBe("# Report\n\nContent here.");
  });

  it("removes vector row when file deleted from disk", async () => {
    const http = seedEmbeddingSettings(ctx);
    ctx = { ...ctx, http };
    ctx.fs.mkdirp(DATA_DIR);
    ctx.fs.writeFile(path.join(DATA_DIR, "gone.md"), "content");
    await runKnowledgeIndex(ctx, {});

    ctx.fs.deleteFile(path.join(DATA_DIR, "gone.md"));
    const result = await runKnowledgeIndex(ctx, {});
    expect(result.indexed).toBe(0);
    expect(result.removed).toBe(1);
    const count = ctx.db
      .prepare("SELECT COUNT(1) as c FROM knowledge_vectors WHERE path = ?")
      .get("gone.md") as { c: number };
    expect(count.c).toBe(0);
  });

  it("respects embedMaxContentLength when embedding file content", async () => {
    writeModelsConfig([{ provider: "ollama", name: "nomic-embed-text" }]);
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("embeddingModel", "ollama/nomic-embed-text");
    /** Settings clamp embedMaxContentLength to at least 500. */
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("embedMaxContentLength", "500");
    let lastInputLen = 0;
    const http = new FakeHttp();
    http.on(
      "/api/show",
      async () =>
        new FakeResponse(200, JSON.stringify({ parameters: "num_ctx 8192" })),
    );
    _clearOllamaEmbedContextLengthCacheForTests();
    http.on("/api/embed", async (_url, init) => {
      const body =
        init?.body && typeof init.body === "string"
          ? (JSON.parse(init.body) as { input: string[] })
          : { input: [] as string[] };
      lastInputLen = body.input[0]?.length ?? 0;
      const embeddings = body.input.map(() => [0.1]);
      return new FakeResponse(200, JSON.stringify({ embeddings }));
    });
    ctx = { ...ctx, http };
    ctx.fs.mkdirp(DATA_DIR);
    const longContent = "x".repeat(1200);
    ctx.fs.writeFile(path.join(DATA_DIR, "long.md"), longContent);

    await runKnowledgeIndex(ctx, {});
    expect(lastInputLen).toBe(500);
  });
});
