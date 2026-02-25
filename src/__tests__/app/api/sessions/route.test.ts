/**
 * @fileoverview Tests for GET/POST /api/sessions.
 * @module __tests__/app/api/sessions/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET, POST, PATCH, DELETE } from "@/app/api/sessions/route";

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

  it("returns sessions with type field", async () => {
    const postReq = createNextRequest("http://localhost/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participants: ["user", "maia"] }),
    });
    await POST(postReq);
    const req = createNextRequest("http://localhost/api/sessions");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: { id: string; type: string }[] };
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(body.sessions[0].type).toBe("user");
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

  it("creates session with type agents when specified", async () => {
    const req = createNextRequest("http://localhost/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participants: ["agent-a", "agent-b"], type: "agents" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json() as { sessionId: string };
    expect(body.sessionId).toBeDefined();
    const listReq = createNextRequest("http://localhost/api/sessions?type=agents");
    const listRes = await GET(listReq);
    const listBody = await listRes.json() as { sessions: { id: string; type: string }[] };
    expect(listBody.sessions.some((s) => s.id === body.sessionId && s.type === "agents")).toBe(true);
  });
});

describe("DELETE /api/sessions", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("deletes session and returns 204", async () => {
    const postReq = createNextRequest("http://localhost/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participants: ["user", "maia"] }),
    });
    const postRes = await POST(postReq);
    const { sessionId } = (await postRes.json()) as { sessionId: string };

    const req = createNextRequest("http://localhost/api/sessions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const res = await DELETE(req);
    expect(res.status).toBe(204);

    const listRes = await GET(createNextRequest("http://localhost/api/sessions"));
    const listBody = await listRes.json() as { sessions: { id: string }[] };
    expect(listBody.sessions.some((s) => s.id === sessionId)).toBe(false);
  });

  it("returns 404 when session does not exist", async () => {
    const req = createNextRequest("http://localhost/api/sessions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "00000000-0000-0000-0000-000000000000" }),
    });
    const res = await DELETE(req);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/sessions", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("renames session and returns 204", async () => {
    const postReq = createNextRequest("http://localhost/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participants: ["user", "maia"] }),
    });
    const postRes = await POST(postReq);
    const { sessionId } = (await postRes.json()) as { sessionId: string };

    const patchReq = createNextRequest("http://localhost/api/sessions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, name: "My thread name" }),
    });
    const res = await PATCH(patchReq);
    expect(res.status).toBe(204);

    const listRes = await GET(createNextRequest("http://localhost/api/sessions"));
    const listBody = await listRes.json() as { sessions: { id: string; name: string }[] };
    const session = listBody.sessions.find((s) => s.id === sessionId);
    expect(session?.name).toBe("My thread name");
  });

  it("returns 404 when session does not exist", async () => {
    const req = createNextRequest("http://localhost/api/sessions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "00000000-0000-0000-0000-000000000000",
        name: "Any",
      }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(404);
  });
});
