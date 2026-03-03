/**
 * @fileoverview Tests for POST /api/test/emit-event.
 * Verifies test-only guard, body validation, and event emission onto the app event bus.
 * @module __tests__/app/api/test/emit-event/route
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext, FakeEvents } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { POST } from "@/app/api/test/emit-event/route";

describe("POST /api/test/emit-event", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.E2E_TEST = "0";
  });

  it("returns 404 when not in test/E2E environment", async () => {
    process.env.NODE_ENV = "production";
    process.env.E2E_TEST = "0";
    const req = createNextRequest("http://localhost/api/test/emit-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "message", data: {} }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON body", async () => {
    const bad = new Request("http://localhost/api/test/emit-event", {
      method: "POST",
      body: "{not-json",
    });
    // cast so POST accepts it as NextRequest
    const req = bad as unknown as Request;

    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid JSON");
  });

  it("returns 400 for structurally invalid body", async () => {
    const req = createNextRequest("http://localhost/api/test/emit-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: 123, data: null }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe(
      "Invalid body: need { event: string, data: object }",
    );
  });

  it("emits event onto FakeEvents bus when body is valid", async () => {
    const events = new FakeEvents();
    _setTestContext(makeTestContext({ events }));

    const payload = {
      event: "message",
      data: { sessionId: "s1", text: "hello" },
    };
    const req = createNextRequest("http://localhost/api/test/emit-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    expect(events.emitted).toContainEqual(payload);
  });
});
