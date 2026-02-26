/**
 * @fileoverview Tests for POST /api/sessions/[id]/history/truncate.
 * @module __tests__/app/api/sessions/[id]/history/truncate/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createSession, appendEntry, getSession } from "@/lib/history";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { POST } from "@/app/api/sessions/[id]/history/truncate/route";

describe("POST /api/sessions/[id]/history/truncate", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns 404 when session does not exist", async () => {
    const req = createNextRequest("http://localhost/api/sessions/nonexistent/history/truncate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keepThroughIndex: 0 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 when body is invalid", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx);
    _setTestContext(ctx);

    const req = createNextRequest(`http://localhost/api/sessions/${sessionId}/history/truncate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req, { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(400);
  });

  it("truncates history and returns 200", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx);
    appendEntry(ctx, sessionId, { role: "user", content: "a", timestamp: new Date().toISOString() });
    appendEntry(ctx, sessionId, { role: "agent", content: "b", timestamp: new Date().toISOString() });
    appendEntry(ctx, sessionId, { role: "user", content: "c", timestamp: new Date().toISOString() });
    _setTestContext(ctx);

    const req = createNextRequest(`http://localhost/api/sessions/${sessionId}/history/truncate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keepThroughIndex: 1 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: sessionId }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const session = getSession(ctx, sessionId);
    expect(session?.original.length).toBe(2);
    expect(session?.original[0].content).toBe("a");
    expect(session?.original[1].content).toBe("b");
  });
});
