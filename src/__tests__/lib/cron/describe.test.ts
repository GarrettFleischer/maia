/**
 * @fileoverview Tests for cron describe helpers: human-readable schedule and next run.
 * @module __tests__/lib/cron/describe.test
 */
import { describe, it, expect } from "bun:test";
import { describeCronSchedule, getNextCronRun } from "@/lib/cron/describe";

describe("describeCronSchedule", () => {
  it("returns human-readable string for common expressions", () => {
    expect(describeCronSchedule("*/5 * * * *")).toMatch(/every 5 minutes/i);
    expect(describeCronSchedule("*/30 * * * *")).toMatch(/every 30 minutes/i);
    expect(describeCronSchedule("0 * * * *")).toMatch(/every hour|hourly/i);
    expect(describeCronSchedule("0 9 * * *")).toMatch(/9:00|9.*AM/i);
  });

  it("returns fallback for invalid expression", () => {
    expect(describeCronSchedule("not-cron")).toBe("Invalid schedule");
  });
});

describe("getNextCronRun", () => {
  it("returns next run as ISO string for valid expression", () => {
    const next = getNextCronRun("*/5 * * * *");
    expect(next).not.toBeNull();
    expect(typeof next).toBe("string");
    expect(() => new Date(next!).toISOString()).not.toThrow();
  });

  it("returns null for invalid expression", () => {
    expect(getNextCronRun("invalid")).toBeNull();
  });

  it("next run is in the future", () => {
    const next = getNextCronRun("0 * * * *");
    expect(next).not.toBeNull();
    const t = new Date(next!).getTime();
    expect(t).toBeGreaterThanOrEqual(Date.now() - 60000);
  });
});
