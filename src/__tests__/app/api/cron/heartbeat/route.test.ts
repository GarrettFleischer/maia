/**
 * @fileoverview Tests for POST /api/cron/heartbeat.
 * @module __tests__/app/api/cron/heartbeat/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { initMaiaAgent } from "@/lib/init";
import { POST } from "@/app/api/cron/heartbeat/route";

describe("POST /api/cron/heartbeat", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    initMaiaAgent(ctx);
    _setTestContext(ctx);
  });

  it("returns 200 with ok and timestamp", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; timestamp: string };
    expect(body.ok).toBe(true);
    expect(body.timestamp).toBeDefined();
  });
});
