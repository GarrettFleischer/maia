/**
 * @fileoverview Tests for GET/POST /api/sessions.
 * @module __tests__/app/api/sessions/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET, POST } from "@/app/api/sessions/route";

describe("GET /api/sessions", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns empty sessions list when none exist", async () => {
    const req = createNextRequest("http://localhost/api/sessions");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });

  it("accepts type query param", async () => {
    const req = createNextRequest("http://localhost/api/sessions?type=user");
    const res = await GET(req);
    expect(res.status).toBe(200);
  });
});

describe("POST /api/sessions", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("creates session and returns sessionId", async () => {
    const req = createNextRequest("http://localhost/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participants: ["user", "maia"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json() as { sessionId: string };
    expect(body.sessionId).toBeDefined();
    expect(typeof body.sessionId).toBe("string");
  });

  it("creates session with default participants when body is empty or invalid", async () => {
    const req = createNextRequest("http://localhost/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json() as { sessionId: string };
    expect(body.sessionId).toBeDefined();
    expect(typeof body.sessionId).toBe("string");
  });
});
