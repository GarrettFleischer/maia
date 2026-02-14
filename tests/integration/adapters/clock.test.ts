/**
 * @fileoverview Integration tests for the real clock adapter.
 * @module tests/integration/adapters/clock
 *
 * @note Tests that the real clock returns valid Date objects and correctly
 * formatted strings.
 */

import { describe, it, expect } from "bun:test";
import { createRealClock } from "../../../src/adapters/clock.js";

describe("Real Clock adapter", () => {
  const clock = createRealClock();

  // ── now() ────────────────────────────────────────────────────────

  it("should return a Date instance", () => {
    const d = clock.now();
    expect(d).toBeInstanceOf(Date);
  });

  it("should return a date close to the current time", () => {
    const before = Date.now();
    const d = clock.now();
    const after = Date.now();
    expect(d.getTime()).toBeGreaterThanOrEqual(before);
    expect(d.getTime()).toBeLessThanOrEqual(after);
  });

  // ── todayString() ────────────────────────────────────────────────

  it("should return YYYY-MM-DD format", () => {
    const s = clock.todayString();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("should match the current date", () => {
    const s = clock.todayString();
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    expect(s).toBe(`${year}-${month}-${day}`);
  });

  // ── timestamp() ──────────────────────────────────────────────────

  it("should return an ISO 8601 string", () => {
    const ts = clock.timestamp();
    // ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("should be parseable back to a Date", () => {
    const ts = clock.timestamp();
    const d = new Date(ts);
    expect(d.getTime()).not.toBeNaN();
  });
});
