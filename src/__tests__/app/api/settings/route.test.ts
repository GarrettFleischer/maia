/**
 * @fileoverview Tests for GET/PUT /api/settings.
 * @module __tests__/app/api/settings/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET, PUT } from "@/app/api/settings/route";

describe("GET /api/settings", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns public settings without raw API keys", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect("openRouterApiKey" in body).toBe(false);
    expect("ollamaApiKey" in body).toBe(false);
    expect("braveSearchApiKey" in body).toBe(false);
    expect("braveAnswersApiKey" in body).toBe(false);
    expect(body.whitelistedModels).toBeDefined();
  });
});

describe("PUT /api/settings", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("updates settings and returns public settings", async () => {
    const req = createNextRequest("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ compressionModel: "ollama/qwen2.5-coder" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { compressionModel: string };
    expect(body.compressionModel).toBe("ollama/qwen2.5-coder");
  });

  it("updates recentFullCount and compressionBatchSize and returns them", async () => {
    const req = createNextRequest("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recentFullCount: 20, compressionBatchSize: 8 }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { recentFullCount: number; compressionBatchSize: number };
    expect(body.recentFullCount).toBe(20);
    expect(body.compressionBatchSize).toBe(8);
  });
});
