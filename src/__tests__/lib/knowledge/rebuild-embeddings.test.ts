/**
 * @fileoverview Tests for rebuildEmbeddings (clear + re-index).
 * @module __tests__/lib/knowledge/rebuild-embeddings
 */
import path from "path";
import { describe, it, expect } from "bun:test";
import {
  makeTestContext,
  FakeHttp,
  FakeResponse,
} from "@/__tests__/helpers/fakes";
import { writeModelsConfig } from "@/lib/models-config";
import { createSession, appendEntry } from "@/lib/history";
import { rebuildEmbeddings } from "@/lib/knowledge/rebuild-embeddings";
import { createVectorStore } from "@/lib/knowledge/vector-store";
import { DATA_DIR } from "@/lib/knowledge/index";

describe("rebuildEmbeddings", () => {
  it("rebuilds knowledge and history into vector tables", async () => {
    const ctx = makeTestContext();
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
    http.on(
      "/api/embed",
      async () =>
        new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] })),
    );

    ctx.fs.mkdirp(DATA_DIR);
    ctx.fs.writeFile(path.join(DATA_DIR, "doc.md"), "# Doc\n\nContent.");
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, {
      role: "user",
      content: "hello",
      timestamp: new Date().toISOString(),
    });

    const result = await rebuildEmbeddings({ ...ctx, http });

    expect(result.knowledgeIndexed).toBe(1);
    expect(result.historyIndexed).toBeGreaterThanOrEqual(1);
    const hv = ctx.db
      .prepare("SELECT COUNT(1) as c FROM history_vectors")
      .get() as { c: number };
    expect(hv.c).toBeGreaterThanOrEqual(1);
  });

  it("clearAll removes all knowledge and history vectors", () => {
    const ctx = makeTestContext();
    const store = createVectorStore(ctx.db);
    ctx.db
      .prepare(
        "INSERT INTO knowledge_vectors (id, path, content, content_hash, embedding_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("k1", "p1", "c", "h", "[0.1]", new Date().toISOString());
    ctx.db
      .prepare(
        "INSERT INTO history_vectors (id, session_id, entry_id, content, embedding_json, is_compressed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("h1", "s1", "e1", "c", "[0.1]", 0, new Date().toISOString());

    store.clearAll();

    expect(store.getAllKnowledgePaths()).toHaveLength(0);
    const historyCount = ctx.db
      .prepare("SELECT COUNT(*) as c FROM history_vectors")
      .get() as { c: number };
    expect(historyCount.c).toBe(0);
  });
});
