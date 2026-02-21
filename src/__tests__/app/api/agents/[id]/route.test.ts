/**
 * @fileoverview Tests for GET/DELETE /api/agents/[id].
 * @module __tests__/app/api/agents/[id]/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { initMaiaAgent } from "@/lib/init";
import { GET, DELETE } from "@/app/api/agents/[id]/route";
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
    const body = await res.json() as { agent: { id: string }; soul: string };
    expect(body.agent.id).toBe("maia");
    expect("soul" in body).toBe(true);
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
