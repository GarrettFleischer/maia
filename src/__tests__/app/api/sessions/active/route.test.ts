/**
 * @fileoverview Tests for GET/PUT /api/sessions/active.
 * @module __tests__/app/api/sessions/active/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createSession } from "@/lib/history";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET, PUT } from "@/app/api/sessions/active/route";

describe("GET /api/sessions/active", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns sessionId and session null when no active session", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string | null; session: unknown };
    expect(body.sessionId).toBeNull();
    expect(body.session).toBeNull();
  });
});

describe("PUT /api/sessions/active", () => {
  it("sets active session and returns ok", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    _setTestContext(ctx);

    const req = createNextRequest("http://localhost/api/sessions/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
