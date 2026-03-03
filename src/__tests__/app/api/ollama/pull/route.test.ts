/**
 * @fileoverview Tests for POST /api/ollama/pull (trigger Ollama model download).
 * @module __tests__/app/api/ollama/pull/route.test
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeResponse } from "@/__tests__/helpers/fakes";
import { POST } from "@/app/api/ollama/pull/route";
import { updateSettings } from "@/lib/settings";

describe("POST /api/ollama/pull", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    updateSettings(ctx, { ollamaBaseUrl: "http://localhost:11434" });
    _setTestContext(ctx);
  });

  it("returns 200 and ok: true when Ollama pull succeeds for valid modelId", async () => {
    let pullBody: { model?: string; stream?: boolean } = {};
    const ctx = makeTestContext();
    updateSettings(ctx, { ollamaBaseUrl: "http://localhost:11434" });
    ctx.http.on("/api/pull", async (_url, init) => {
      if (init?.body && typeof init.body === "string") {
        pullBody = JSON.parse(init.body) as { model?: string; stream?: boolean };
      }
      return new FakeResponse(200, "{}");
    });
    _setTestContext(ctx);

    const req = createNextRequest("http://localhost/api/ollama/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "ollama/llama3.2" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(pullBody.model).toBe("llama3.2");
    expect(pullBody.stream).toBe(false);
  });

  it("returns 400 when modelId is missing", async () => {
    const req = createNextRequest("http://localhost/api/ollama/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when modelId is not a string", async () => {
    const req = createNextRequest("http://localhost/api/ollama/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: 123 }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when modelId does not start with ollama/", async () => {
    const req = createNextRequest("http://localhost/api/ollama/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "openrouter/free" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("returns 502 when Ollama pull responds with non-2xx status", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { ollamaBaseUrl: "http://localhost:11434" });
    ctx.http.on("/api/pull", async () => new FakeResponse(500, "Internal Server Error"));
    _setTestContext(ctx);

    const req = createNextRequest("http://localhost/api/ollama/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "ollama/llama3.2" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });
});
