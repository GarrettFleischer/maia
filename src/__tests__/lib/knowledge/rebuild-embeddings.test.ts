/**
 * @fileoverview Tests for rebuildEmbeddings (clear + re-index).
 * @module __tests__/lib/knowledge/rebuild-embeddings
 */
import path from "path";
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext, FakeResponse } from "@/__tests__/helpers/fakes";
import { updateSettings } from "@/lib/settings";
import { createSession, appendEntry } from "@/lib/history";
import { rebuildEmbeddings } from "@/lib/knowledge/rebuild-embeddings";
import { createVectorStore } from "@/lib/knowledge/vector-store";
import { KNOWLEDGE_DIR } from "@/lib/knowledge/index";

describe("rebuildEmbeddings", () => {
  it("clears all vectors and rebuilds knowledge and history", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
    });
    (
      ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }
    ).on(
      "/api/embed",
      async () => new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] }))
    );

    ctx.fs.mkdirp(KNOWLEDGE_DIR);
    ctx.fs.writeFile(path.join(KNOWLEDGE_DIR, "doc.md"), "# Doc\n\nContent.");
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, {
      role: "user",
      content: "hello",
      timestamp: new Date().toISOString(),
    });

    const result = await rebuildEmbeddings(ctx);

    expect(result.knowledgeIndexed).toBe(1);
    expect(result.historyIndexed).toBeGreaterThanOrEqual(1);

    const store = createVectorStore(ctx.db);
    expect(store.getAllKnowledgePaths()).toContain("doc.md");
  });

  it("clearAll removes all knowledge and history vectors", () => {
    const ctx = makeTestContext();
    const store = createVectorStore(ctx.db);
    ctx.db.prepare("INSERT INTO knowledge_vectors (id, path, content, content_hash, embedding_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("k1", "p1", "c", "h", "[0.1]", new Date().toISOString());
    ctx.db.prepare("INSERT INTO history_vectors (id, session_id, entry_id, content, embedding_json, is_compressed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("h1", "s1", "e1", "c", "[0.1]", 0, new Date().toISOString());

    store.clearAll();

    expect(store.getAllKnowledgePaths()).toHaveLength(0);
    const historyCount = ctx.db.prepare("SELECT COUNT(*) as c FROM history_vectors").get() as { c: number };
    expect(historyCount.c).toBe(0);
  });
});
