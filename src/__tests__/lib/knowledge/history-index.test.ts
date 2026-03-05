/**
 * @fileoverview Tests for history indexing (vector store and MuninnDB path).
 * Covers skipping missing/empty entries, Muninn engram write when enabled, and vector-store indexing.
 * @module __tests__/lib/knowledge/history-index
 */

import { describe, it, expect, spyOn } from "bun:test";
import { indexHistoryEntry } from "@/lib/knowledge/history-index";
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

  it("writes engram to Muninn when muninnUrl is set and does not touch vector store", async () => {
    const [ctx, id] = seedHistoryEntry("User asked about auth.");
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("muninnUrl", "http://localhost:8475");
    let capturedBody: Record<string, unknown> = {};
    const http = new FakeHttp();
    http.on("/api/engrams", async (_url, init) => {
      const body =
        init?.body && typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      capturedBody = body;
      return new FakeResponse(200, JSON.stringify({ id: "eng-1" }));
    });
    const ctxWithHttp: AppContext = { ...ctx, http };

    await indexHistoryEntry(ctxWithHttp, id);

    expect(capturedBody.vault).toBe("default");
    expect(capturedBody.concept).toBe("session:entry-1 entry:entry-1");
    expect(capturedBody.content).toBe("User asked about auth.");
    expect(capturedBody.tags).toEqual([
      "history",
      "entry-1",
      "entry-1",
      "user",
      "original",
    ]);
    const vectors = ctx.db
      .prepare("SELECT COUNT(1) as count FROM history_vectors")
      .get() as { count: number };
    expect(vectors.count).toBe(0);
  });
});
