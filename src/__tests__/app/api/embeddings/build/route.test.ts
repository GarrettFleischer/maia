/**
 * @fileoverview Tests for POST /api/embeddings/build.
 * @module __tests__/app/api/embeddings/build/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeResponse } from "@/__tests__/helpers/fakes";
import { updateSettings } from "@/lib/settings";
import { createSession, appendEntry } from "@/lib/history";
import { POST } from "@/app/api/embeddings/build/route";

describe("POST /api/embeddings/build", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
    });
    (
      ctx.http as { on: (p: string, h: (url: string, init?: RequestInit) => Promise<FakeResponse>) => void }
    ).on("/api/embed", async (_url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { input?: string | string[] }) : {};
      const input = body.input;
      const count = Array.isArray(input) ? input.length : 1;
      const embeddings = Array.from({ length: count }, () => [0.1, 0.2]);
      return new FakeResponse(200, JSON.stringify({ embeddings }));
    });
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
    expect(typeof body.historyIndexed).toBe("number");
  });

  it("indexes unindexed history without clearing", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, {
      whitelistedModels: ["ollama/nomic-embed-text"],
      embeddingModel: "ollama/nomic-embed-text",
    });
    (
      ctx.http as { on: (p: string, h: (url: string, init?: RequestInit) => Promise<FakeResponse>) => void }
    ).on("/api/embed", async (_url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as { input?: string | string[] }) : {};
      const count = Array.isArray(body.input) ? body.input.length : 1;
      const embeddings = Array.from({ length: count }, () => [0.1, 0.2]);
      return new FakeResponse(200, JSON.stringify({ embeddings }));
    });
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, {
      role: "user",
      content: "test for build",
      timestamp: new Date().toISOString(),
    });
    _setTestContext(ctx);

    const res = await POST();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; historyIndexed: number };
    expect(body.ok).toBe(true);
    expect(body.historyIndexed).toBeGreaterThanOrEqual(1);
  });
});
