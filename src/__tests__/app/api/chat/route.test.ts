/**
 * @fileoverview Tests for POST /api/chat.
 * @module __tests__/app/api/chat/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { initMaiaAgent } from "@/lib/init";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { POST } from "@/app/api/chat/route";

describe("POST /api/chat", () => {
  beforeEach(() => {
    const ctx = makeTestContext();
    initMaiaAgent(ctx);
    _setTestContext(ctx);
  });

  it("returns 400 for invalid body", async () => {
    const req = createNextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when targetAgent is not a known agent or catalog persona", async () => {
    const req = createNextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hi", targetAgent: "not-a-real-agent-or-persona-slug-xyz" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns stream with text/event-stream when body valid", async () => {
    const req = createNextRequest("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Hello" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.body).toBeDefined();
  });
});
