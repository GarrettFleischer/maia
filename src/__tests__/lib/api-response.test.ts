/**
 * @fileoverview Tests for the API error response helper in `src/lib/api-response.ts`.
 * Ensures standard JSON error shape and status codes are respected.
 * @module __tests__/lib/api-response
 *
 * @example
 * // See apiError tests for usage.
 */

import { describe, it, expect } from "bun:test";
import { apiError } from "@/lib/api-response";

describe("api-response", () => {
  it("returns standard error body and status", async () => {
    const res = apiError("Bad input", 400);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; code?: string };
    expect(json).toEqual({ error: "Bad input" });
  });

  it("includes optional error code when provided", async () => {
    const res = apiError("Not found", 404, "NOT_FOUND");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string; code?: string };
    expect(json).toEqual({ error: "Not found", code: "NOT_FOUND" });
  });
});
