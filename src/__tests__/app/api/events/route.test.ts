/**
 * @fileoverview Tests for GET /api/events (SSE stream).
 * @module __tests__/app/api/events/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET } from "@/app/api/events/route";

describe("GET /api/events", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns 200 with text/event-stream", async () => {
    const req = createNextRequest("http://localhost/api/events");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("returns a stream body", async () => {
    const req = createNextRequest("http://localhost/api/events");
    const res = await GET(req);
    expect(res.body).toBeDefined();
  });

  it("stream sends SSE-formatted data when consumed", async () => {
    const ctx = makeTestContext();
    _setTestContext(ctx);
    const req = createNextRequest("http://localhost/api/events");
    const res = await GET(req);
    expect(res.body).toBeDefined();
    const reader = res.body!.getReader();
    ctx.events.emit({ event: "ping", data: { timestamp: new Date().toISOString() } });
    const { value } = await reader.read();
    reader.releaseLock();
    expect(value).toBeDefined();
    const text = new TextDecoder().decode(value);
    expect(text).toMatch(/^event: /);
    expect(text).toContain("data: ");
  });

  it("handles abort without error (cleanup on client disconnect)", async () => {
    const ac = new AbortController();
    const req = createNextRequest("http://localhost/api/events", { signal: ac.signal });
    const resPromise = GET(req);
    ac.abort();
    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    const reader = res.body!.getReader();
    await reader.read().catch(() => {});
    reader.releaseLock();
  });
});
