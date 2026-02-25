/**
 * @fileoverview Tests for GET /api/history/search.
 * @module __tests__/app/api/history/search/route.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { _setTestContext } from "@/instrumentation";
import { makeTestContext } from "@/__tests__/helpers/fakes";
import { createNextRequest } from "@/__tests__/helpers/next-request";
import { GET } from "@/app/api/history/search/route";

describe("GET /api/history/search", () => {
  beforeEach(() => {
    _setTestContext(makeTestContext());
  });

  it("returns results object", async () => {
    const req = createNextRequest(
      "http://localhost/api/history/search?q=test"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown };
    expect(body.results).toBeDefined();
  });

  it("accepts mode param (compressed, original, both)", async () => {
    const req = createNextRequest(
      "http://localhost/api/history/search?q=test&mode=compressed"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown[] };
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("accepts tags param as comma-separated", async () => {
    const req = createNextRequest(
      "http://localhost/api/history/search?q=test&tags=foo%2Cbar"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: unknown };
    expect(body.results).toBeDefined();
  });
});
