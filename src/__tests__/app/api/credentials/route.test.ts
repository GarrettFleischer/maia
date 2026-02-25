/**
 * @fileoverview Tests for GET/POST /api/credentials.
 * @module __tests__/app/api/credentials/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET, POST } from "@/app/api/credentials/route";

describe("GET /api/credentials", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns keys array", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: string[] };
    expect(body.keys).toBeDefined();
    expect(Array.isArray(body.keys)).toBe(true);
  });
});

describe("POST /api/credentials", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("creates credential and returns 201", async () => {
    const req = createNextRequest("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "test_key", value: "secret" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
