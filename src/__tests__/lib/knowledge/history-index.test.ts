/**
 * @fileoverview Tests for history indexing (SQLite history_vectors).
 * @module __tests__/lib/knowledge/history-index
 */

import { describe, it, expect, spyOn } from "bun:test";
import { indexHistoryEntry } from "@/lib/knowledge/history-index";
import { _clearOllamaEmbedContextLengthCacheForTests } from "@/lib/knowledge/embedding";
import { writeModelsConfig } from "@/lib/models-config";
import {
  makeTestContext,
  FakeHttp,
  FakeResponse,
} from "@/__tests__/helpers/fakes";
import type { AppContext } from "@/lib/context";

/**
 * @brief Creates a test context and seeds a history entry row.
 * @param content - History content to persist.
 * @returns Tuple of AppContext and inserted entry id.
 */
function seedHistoryEntry(content: string): [AppContext, string] {
  const ctx = makeTestContext();
  const id = "entry-1";
  ctx.db
    .prepare(
      "INSERT INTO sessions (id, name, description, participants, tags, type, created_at, updated_at) VALUES (?, ?, '', '[]', '[]', 'user', ?, ?)",
    )
    .run(
      id,
      "Test session",
      new Date().toISOString(),
      new Date().toISOString(),
    );
  ctx.db
    .prepare(
      "INSERT INTO history_entries (id, session_id, role, content, tool_name, tool_args, timestamp, is_compressed) VALUES (?, ?, 'user', ?, NULL, NULL, ?, 0)",
    )
    .run(id, id, content, new Date().toISOString());
  return [ctx, id];
}

describe("history-index", () => {
  it("returns early when history entry does not exist", async () => {
    const ctx = makeTestContext();
    const infoSpy = spyOn(console, "info");
    const errorSpy = spyOn(console, "error");

    await indexHistoryEntry(ctx, "missing");

    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("skips indexing for thinking role entries", async () => {
    const ctx = makeTestContext();
    const sid = "sess-1";
    const eid = "entry-thinking";
    ctx.db
      .prepare(
        "INSERT INTO sessions (id, name, description, participants, tags, type, created_at, updated_at) VALUES (?, ?, '', '[]', '[]', 'user', ?, ?)",
      )
      .run(sid, "S", new Date().toISOString(), new Date().toISOString());
    ctx.db
      .prepare(
        "INSERT INTO history_entries (id, session_id, role, content, tool_name, tool_args, timestamp, is_compressed) VALUES (?, ?, 'thinking', ?, NULL, NULL, ?, 0)",
      )
      .run(eid, sid, "internal chain-of-thought", new Date().toISOString());
    writeModelsConfig([{ provider: "ollama", name: "nomic-embed-text" }]);
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("embeddingModel", "ollama/nomic-embed-text");
    const http = new FakeHttp();
    http.on(
      "/api/show",
      async () =>
        new FakeResponse(200, JSON.stringify({ parameters: "num_ctx 2048" })),
    );
    http.on("/api/embed", async () => {
      throw new Error("embed should not run for thinking");
    });
    await indexHistoryEntry({ ...ctx, http }, eid);
    const row = ctx.db
      .prepare("SELECT COUNT(1) as c FROM history_vectors WHERE entry_id = ?")
      .get(eid) as { c: number };
    expect(row.c).toBe(0);
  });

  it("skips indexing when content is empty", async () => {
    const [ctx, id] = seedHistoryEntry("   ");
    const infoSpy = spyOn(console, "info");
    const errorSpy = spyOn(console, "error");

    await indexHistoryEntry(ctx, id);

    const vectors = ctx.db
      .prepare(
        "SELECT COUNT(1) as count FROM history_vectors WHERE entry_id = ?",
      )
      .get(id) as { count: number };
    expect(vectors.count).toBe(0);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("indexes short content to vector store as single row", async () => {
    const [ctx, id] = seedHistoryEntry("Short message.");
    writeModelsConfig([{ provider: "ollama", name: "nomic-embed-text" }]);
    const stmt = ctx.db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    );
    stmt.run("embeddingModel", "ollama/nomic-embed-text");
    const http = new FakeHttp();
    http.on(
      "/api/show",
      async () =>
        new FakeResponse(200, JSON.stringify({ parameters: "num_ctx 2048" })),
    );
    http.on("/api/embed", async (_url, init) => {
      const body =
        init?.body && typeof init.body === "string"
          ? (JSON.parse(init.body) as { input: string[] })
          : { input: [] as string[] };
      const embeddings = body.input.map(() => [0.1, 0.2]);
      return new FakeResponse(200, JSON.stringify({ embeddings }));
    });
    const ctxWithHttp: AppContext = { ...ctx, http };

    await indexHistoryEntry(ctxWithHttp, id);

    const rows = ctx.db
      .prepare(
        "SELECT id, entry_id, content FROM history_vectors WHERE entry_id = ?",
      )
      .all(id) as { id: string; entry_id: string; content: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("Short message.");
    expect(rows[0].id).toBe(id);
  });

  it("indexes long content to vector store as multiple chunks", async () => {
    _clearOllamaEmbedContextLengthCacheForTests();
    const longContent = "a".repeat(100);
    const [ctx, id] = seedHistoryEntry(longContent);
    writeModelsConfig([{ provider: "ollama", name: "nomic-embed-text" }]);
    const stmt = ctx.db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    );
    stmt.run("embeddingModel", "ollama/nomic-embed-text");
    const http = new FakeHttp();
    http.on(
      "/api/show",
      async () =>
        new FakeResponse(200, JSON.stringify({ parameters: "num_ctx 10" })),
    );
    const embedCalls: string[][] = [];
    http.on("/api/embed", async (_url, init) => {
      const body =
        init?.body && typeof init.body === "string"
          ? (JSON.parse(init.body) as { input: string[] })
          : { input: [] as string[] };
      embedCalls.push(body.input);
      const embeddings = body.input.map(() => [0.1, 0.2]);
      return new FakeResponse(200, JSON.stringify({ embeddings }));
    });
    const ctxWithHttp: AppContext = { ...ctx, http };

    await indexHistoryEntry(ctxWithHttp, id);

    const rows = ctx.db
      .prepare(
        "SELECT id, entry_id, content FROM history_vectors WHERE entry_id = ? ORDER BY id",
      )
      .all(id) as { id: string; entry_id: string; content: string }[];
    expect(rows.length).toBeGreaterThan(1);
    const totalChars = rows.reduce((s, r) => s + r.content.length, 0);
    expect(totalChars).toBe(100);
    expect(embedCalls.length).toBeGreaterThanOrEqual(1);
    const totalChunked = embedCalls.flat().reduce((s, c) => s + c.length, 0);
    expect(totalChunked).toBe(100);
  });

});
