/**
 * @fileoverview Unit tests for queue manager and isNetworkError (retriable error detection).
 * @module tests/unit/providers/queue-manager
 *
 * @brief isNetworkError determines whether a job is released for retry (503, 502, 504, 429, etc.)
 * or removed and failed.
 */

import { describe, it, expect } from "bun:test";
import { isNetworkError } from "../../../src/providers/queue-manager.js";

describe("isNetworkError", () => {
  it("returns true for 503 (e.g. Gemini high demand)", () => {
    expect(isNetworkError(new Error("Gemini API error: 503 {\"error\":{\"message\":\"high demand\"}}"))).toBe(true);
  });

  it("returns true for 502 and 504", () => {
    expect(isNetworkError(new Error("API error: 502 Bad Gateway"))).toBe(true);
    expect(isNetworkError(new Error("API error: 504 Gateway Timeout"))).toBe(true);
  });

  it("returns true for unavailable in message", () => {
    expect(isNetworkError(new Error("status UNAVAILABLE"))).toBe(true);
  });

  it("returns true for 429 and rate limit", () => {
    expect(isNetworkError(new Error("429 Too Many Requests"))).toBe(true);
    expect(isNetworkError(new Error("rate limit exceeded"))).toBe(true);
  });

  it("returns false for non-retriable errors", () => {
    expect(isNetworkError(new Error("400 Bad Request"))).toBe(false);
    expect(isNetworkError(new Error("401 Unauthorized"))).toBe(false);
    expect(isNetworkError(new Error("Validation failed"))).toBe(false);
  });
});
