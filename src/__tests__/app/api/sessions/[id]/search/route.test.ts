/**
 * @fileoverview Tests for GET /api/sessions/[id]/search.
 * @module __tests__/app/api/sessions/[id]/search/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createSession } from "@/lib/history";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET } from "@/app/api/sessions/[id]/search/route";

describe("GET /api/sessions/[id]/search", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns entries array", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    _setTestContext(ctx);

    const req = createNextRequest(
      `http://localhost/api/sessions/${sessionId}/search?q=foo`
    );
    const res = await GET(req, { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[] };
    expect(body.entries).toBeDefined();
    expect(Array.isArray(body.entries)).toBe(true);
  });
});
