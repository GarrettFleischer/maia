/**
 * @fileoverview Tests for POST /api/embeddings/rebuild.
 * @module __tests__/app/api/embeddings/rebuild/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import {
  makeTestContext,
  FakeHttp,
  FakeResponse,
} from "@/__tests__/helpers/fakes";
import { updateSettings } from "@/lib/settings";
import { createSession, appendEntry } from "@/lib/history";
import { POST } from "@/app/api/embeddings/rebuild/route";

describe("POST /api/embeddings/rebuild", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
    });
    (
      ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }
    ).on(
      "/api/embed",
      async () =>
        new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] })),
    );
    _setTestContext(ctx);
  });

  it("returns 200 with ok and counts", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      knowledgeIndexed: number;
      knowledgeRemoved: number;
      historyIndexed: number;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.knowledgeIndexed).toBe("number");
    expect(typeof body.knowledgeRemoved).toBe("number");
    expect(typeof body.historyIndexed).toBe("number");
  });

  it("rebuilds history embeddings to Muninn when entries exist", async () => {
    const ctx = makeTestContext();
    ctx.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("muninnUrl", "http://localhost:8475");
    const http = new FakeHttp();
    http.on(
      "/api/engrams",
      async () => new FakeResponse(200, JSON.stringify({ id: "eng-1" })),
    );
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, {
      role: "user",
      content: "test message for rebuild",
      timestamp: new Date().toISOString(),
    });
    _setTestContext({ ...ctx, http });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; historyIndexed: number };
    expect(body.ok).toBe(true);
    expect(body.historyIndexed).toBeGreaterThanOrEqual(1);
  });
});
