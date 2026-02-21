/**
 * @fileoverview Tests for GET /api/sessions/[id].
 * @module __tests__/app/api/sessions/[id]/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createSession } from "@/lib/history";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET } from "@/app/api/sessions/[id]/route";

describe("GET /api/sessions/[id]", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns 404 when session does not exist", async () => {
    const req = createNextRequest("http://localhost/api/sessions/nonexistent");
    const res = await GET(req, { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns session when found", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    _setTestContext(ctx);

    const req = createNextRequest(`http://localhost/api/sessions/${sessionId}`);
    const res = await GET(req, { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; original: unknown[]; compressed: unknown[] };
    expect(body.id).toBe(sessionId);
    expect(Array.isArray(body.original)).toBe(true);
    expect(Array.isArray(body.compressed)).toBe(true);
  });
});
