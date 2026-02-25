/**
 * @fileoverview Tests for GET /api/agents (list agents).
 * @module __tests__/app/api/agents/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { initMaiaAgent } from "@/lib/init";
import { GET } from "@/app/api/agents/route";

describe("GET /api/agents", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    initMaiaAgent(ctx);
    _setTestContext(ctx);
  });

  it("returns agents list with maia when seeded", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: { id: string }[] };
    expect(body.agents).toBeDefined();
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.some((a) => a.id === "maia")).toBe(true);
  });
});
