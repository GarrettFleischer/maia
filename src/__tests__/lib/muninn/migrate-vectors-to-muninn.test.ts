/**
 * @fileoverview Tests for one-time migration of vectors to Muninn engrams.
 * @module __tests__/lib/muninn/migrate-vectors-to-muninn.test
 */

import { describe, it, expect } from "bun:test";
import {
  makeTestContext,
  FakeHttp,
  FakeResponse,
} from "@/__tests__/helpers/fakes";
import { migrateVectorsToMuninn } from "@/lib/muninn/migrate-vectors-to-muninn";

describe("migrateVectorsToMuninn", () => {
  it("returns error when Muninn is not configured", async () => {
    const ctx = makeTestContext();
    const result = await migrateVectorsToMuninn(ctx);
    expect(result.error).toContain("Muninn is not configured");
    expect(result.knowledgeWritten).toBe(0);
    expect(result.historyWritten).toBe(0);
  });

  it("reads knowledge_vectors and history_vectors and writes batch to Muninn", async () => {
    const ctx = makeTestContext();
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("muninnUrl", "http://localhost:8475");

    ctx.db
      .prepare(
        "INSERT INTO knowledge_vectors (id, path, content, content_hash, embedding_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "kv1",
        "user/notes.md",
        "Note content",
        "hash1",
        "[]",
        new Date().toISOString(),
      );

    ctx.db
      .prepare(
        "INSERT INTO sessions (id, name, description, participants, tags, type, created_at, updated_at) VALUES (?, ?, '', '[]', '[]', 'user', ?, ?)",
      )
      .run("s1", "Session", new Date().toISOString(), new Date().toISOString());

    ctx.db
      .prepare(
        "INSERT INTO history_vectors (id, session_id, entry_id, content, embedding_json, is_compressed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "hv1",
        "s1",
        "e1",
        "History content",
        "[]",
        0,
        new Date().toISOString(),
      );

    const batchBodies: { engrams: unknown[] }[] = [];
    const http = new FakeHttp();
    http.on("/api/engrams/batch", async (_url, init) => {
      const body =
        init?.body && typeof init.body === "string"
          ? (JSON.parse(init.body) as { engrams: unknown[] })
          : { engrams: [] };
      batchBodies.push(body);
      return new FakeResponse(
        200,
        JSON.stringify({ ids: body.engrams.map((_, i) => `id-${i}`) }),
      );
    });
    const ctxWithHttp = { ...ctx, http };

    const result = await migrateVectorsToMuninn(ctxWithHttp);

    expect(result.error).toBeUndefined();
    expect(result.knowledgeWritten).toBe(1);
    expect(result.historyWritten).toBe(1);
    expect(batchBodies).toHaveLength(1);
    const engrams = batchBodies[0].engrams as Array<{
      vault: string;
      concept: string;
      content: string;
      tags: string[];
    }>;
    expect(engrams).toHaveLength(2);
    const knowledgeEngram = engrams.find((e) => e.tags[0] === "knowledge");
    const historyEngram = engrams.find((e) => e.tags[0] === "history");
    expect(knowledgeEngram?.vault).toBe("default");
    expect(knowledgeEngram?.concept).toBe("user/notes.md");
    expect(knowledgeEngram?.content).toBe("Note content");
    expect(knowledgeEngram?.tags).toEqual(["knowledge", "user/notes.md"]);
    expect(historyEngram?.vault).toBe("default");
    expect(historyEngram?.concept).toBe("session:s1 entry:e1");
    expect(historyEngram?.content).toBe("History content");
    expect(historyEngram?.tags).toContain("s1");
    expect(historyEngram?.tags).toContain("e1");
    expect(historyEngram?.tags).toContain("original");
  });
});
