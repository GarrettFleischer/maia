/**
 * @fileoverview Tests for delayUntilNextBoundaryMs (wall-clock alignment).
 * @module __tests__/lib/schedule-boundary
 */
import { describe, it, expect } from "bun:test";
import { delayUntilNextBoundaryMs } from "@/lib/schedule-boundary";

describe("delayUntilNextBoundaryMs", () => {
  it("returns ~15 min when at 3:15 and interval is 30 min", () => {
    // 3:15 = 3*60+15 = 195 min from midnight; 195*60*1000 ms
    const threeFifteen = 3 * 60 * 60 * 1000 + 15 * 60 * 1000;
    const delay = delayUntilNextBoundaryMs(30, threeFifteen);
    expect(delay).toBe(15 * 60 * 1000); // 15 min to 3:30
  });

  it("returns 30 min when at 3:00 and interval is 30 min", () => {
    const threeOClock = 3 * 60 * 60 * 1000;
    const delay = delayUntilNextBoundaryMs(30, threeOClock);
    expect(delay).toBe(30 * 60 * 1000);
  });

  it("returns 30 min when at 3:30 and interval is 30 min (next boundary 4:00)", () => {
    const threeThirty = 3 * 60 * 60 * 1000 + 30 * 60 * 1000;
    const delay = delayUntilNextBoundaryMs(30, threeThirty);
    expect(delay).toBe(30 * 60 * 1000);
  });

  it("returns ~45 min when at 3:15 and interval is 60 min", () => {
    const threeFifteen = 3 * 60 * 60 * 1000 + 15 * 60 * 1000;
    const delay = delayUntilNextBoundaryMs(60, threeFifteen);
    expect(delay).toBe(45 * 60 * 1000); // to 4:00
  });

  it("returns 60 min when at 4:00 and interval is 60 min", () => {
    const fourOClock = 4 * 60 * 60 * 1000;
    const delay = delayUntilNextBoundaryMs(60, fourOClock);
    expect(delay).toBe(60 * 60 * 1000);
  });
});
