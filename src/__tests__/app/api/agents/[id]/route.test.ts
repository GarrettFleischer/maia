/**
 * @fileoverview Tests for GET/DELETE/PATCH /api/agents/[id].
 * @module __tests__/app/api/agents/[id]/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { initMaiaAgent } from "@/lib/init";
import { updateSettings } from "@/lib/settings";
import { GET, DELETE, PATCH } from "@/app/api/agents/[id]/route";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import type { NextRequest } from "next/server";

function reqWithParams(id: string): NextRequest {
  return new Request("http://localhost") as NextRequest;
}

describe("GET /api/agents/[id]", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    initMaiaAgent(ctx);
    _setTestContext(ctx);
  });

  it("returns agent with identity when found", async () => {
    const res = await GET(reqWithParams("maia"), {
      params: Promise.resolve({ id: "maia" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { agent: { id: string }; persona: string };
    expect(body.agent.id).toBe("maia");
    expect("persona" in body).toBe(true);
  });

  it("returns 404 when agent not found", async () => {
    const res = await GET(reqWithParams("nonexistent"), {
      params: Promise.resolve({ id: "nonexistent" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/agents/[id]", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    initMaiaAgent(ctx);
    _setTestContext(ctx);
  });

  it("returns ok and soft-deletes agent", async () => {
    const res = await DELETE(reqWithParams("maia"), {
      params: Promise.resolve({ id: "maia" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("PATCH /api/agents/[id]", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    initMaiaAgent(ctx);
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2", "ollama/qwen2.5-coder"] });
    _setTestContext(ctx);
  });

  it("updates agent model and returns 200", async () => {
    const req = createNextRequest("http://localhost/api/agents/maia", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ollama/qwen2.5-coder" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "maia" }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { agent: { id: string; model: string } };
    expect(body.agent.id).toBe("maia");
    expect(body.agent.model).toBe("ollama/qwen2.5-coder");
  });

  it("updates agent name and returns 200", async () => {
    const req = createNextRequest("http://localhost/api/agents/maia", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Maia Prime" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "maia" }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { agent: { id: string; name: string } };
    expect(body.agent.name).toBe("Maia Prime");
  });

  it("returns 404 when agent not found", async () => {
    const req = createNextRequest("http://localhost/api/agents/nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ollama/llama3.2" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 when model is not whitelisted", async () => {
    const req = createNextRequest("http://localhost/api/agents/maia", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "evil/unknown-model" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "maia" }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toContain("not whitelisted");
  });
});
