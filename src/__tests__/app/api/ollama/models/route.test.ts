/**
 * @fileoverview Tests for GET /api/ollama/models (list downloaded Ollama models).
 * @module __tests__/app/api/ollama/models/route.test
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeResponse } from "@/__tests__/helpers/fakes";
import { GET } from "@/app/api/ollama/models/route";
import { updateSettings } from "@/lib/settings";

describe("GET /api/ollama/models", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns downloaded subset of requested Ollama model ids", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { ollamaBaseUrl: "http://localhost:11434" });
    ctx.http.on("/api/tags", async () =>
      new FakeResponse(200, JSON.stringify({
        models: [
          { name: "llama3.2" },
          { name: "nomic-embed-text:latest" },
        ],
      })),
    );
    _setTestContext(ctx);

    const req = createNextRequest(
      "http://localhost/api/ollama/models?modelIds=ollama/llama3.2,ollama/nomic-embed-text,ollama/missing,openrouter/free",
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { downloaded: string[] };
    expect(Array.isArray(body.downloaded)).toBe(true);
    expect(body.downloaded).toContain("ollama/llama3.2");
    expect(body.downloaded).toContain("ollama/nomic-embed-text");
    expect(body.downloaded).not.toContain("ollama/missing");
    expect(body.downloaded).not.toContain("openrouter/free");
    expect(body.downloaded.length).toBe(2);
  });

  it("returns empty downloaded when no Ollama ids requested", async () => {
    const ctx = makeTestContext();
    _setTestContext(ctx);

    const req = createNextRequest(
      "http://localhost/api/ollama/models?modelIds=openrouter/free",
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { downloaded: string[] };
    expect(body.downloaded).toEqual([]);
  });

  it("returns empty downloaded when Ollama tags request fails", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { ollamaBaseUrl: "http://localhost:11434" });
    ctx.http.on("/api/tags", async () => new FakeResponse(503, "Service Unavailable"));
    _setTestContext(ctx);

    const req = createNextRequest(
      "http://localhost/api/ollama/models?modelIds=ollama/llama3.2",
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { downloaded: string[] };
    expect(body.downloaded).toEqual([]);
  });

  it("returns available Ollama model names when no modelIds query", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { ollamaBaseUrl: "http://localhost:11434" });
    ctx.http.on("/api/tags", async () =>
      new FakeResponse(200, JSON.stringify({
        models: [
          { name: "nomic-embed-text:latest" },
          { name: "llama3.2" },
        ],
      })),
    );
    _setTestContext(ctx);

    const req = createNextRequest("http://localhost/api/ollama/models");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: string[] };
    expect(Array.isArray(body.available)).toBe(true);
    expect(body.available).toEqual(["llama3.2", "nomic-embed-text:latest"]);
  });

  it("returns empty available when no base URL", async () => {
    const ctx = makeTestContext();
    updateSettings(ctx, { ollamaBaseUrl: "" });
    _setTestContext(ctx);

    const req = createNextRequest("http://localhost/api/ollama/models");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: string[] };
    expect(body.available).toEqual([]);
  });
});
