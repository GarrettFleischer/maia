/**
 * @fileoverview Integration tests for GET /api/health.
 * @module tests/api/health.test
 */

import { describe, expect, it } from "bun:test";
import { GET } from "@/app/api/health/route";

const API_KEY = "test-api-key";

describe("GET /api/health", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const orig = process.env.MAIA_API_KEY;
    process.env.MAIA_API_KEY = API_KEY;
    const request = new Request("http://localhost/api/health", { headers: {} });
    const response = await GET(request);
    process.env.MAIA_API_KEY = orig;
    expect(response.status).toBe(401);
  });

  it("returns 200 with valid Bearer token", async () => {
    const orig = process.env.MAIA_API_KEY;
    process.env.MAIA_API_KEY = API_KEY;
    const request = new Request("http://localhost/api/health", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const response = await GET(request);
    process.env.MAIA_API_KEY = orig;
    expect(response.status).toBe(200);
  });

  it("returns JSON with ok true when authorized", async () => {
    const orig = process.env.MAIA_API_KEY;
    process.env.MAIA_API_KEY = API_KEY;
    const request = new Request("http://localhost/api/health", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const response = await GET(request);
    process.env.MAIA_API_KEY = orig;
    const data = (await response.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});
