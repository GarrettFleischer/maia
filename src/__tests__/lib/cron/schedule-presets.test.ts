/**
 * @fileoverview Tests for shared cron schedule quick-pick presets.
 * @module __tests__/lib/cron/schedule-presets.test
 */

import { describe, it, expect } from "bun:test";
import {
  matchExpressionToPresetId,
  normalizeCronExpression,
  SCHEDULE_PRESETS,
} from "@/lib/cron/schedule-presets";

describe("normalizeCronExpression", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeCronExpression("  0  9  *  *  *  ")).toBe("0 9 * * *");
  });
});

describe("matchExpressionToPresetId", () => {
  it("returns preset id for exact preset expressions", () => {
    expect(matchExpressionToPresetId("*/15 * * * *")).toBe("15m");
    expect(matchExpressionToPresetId("0 9 * * 1-5")).toBe("weekday9");
  });

  it("matches after normalization", () => {
    expect(matchExpressionToPresetId("  0 9 * * *  ")).toBe("daily9");
  });

  it("returns undefined when no preset matches", () => {
    expect(matchExpressionToPresetId("0 */6 * * *")).toBeUndefined();
  });

  it("respects custom preset list", () => {
    const tiny = [{ id: "x", label: "X", expression: "1 2 3 4 5" }];
    expect(matchExpressionToPresetId("1 2 3 4 5", tiny)).toBe("x");
    expect(matchExpressionToPresetId("0 9 * * *", tiny)).toBeUndefined();
  });

  it("every preset id resolves from its own expression", () => {
    for (const p of SCHEDULE_PRESETS) {
      expect(matchExpressionToPresetId(p.expression)).toBe(p.id);
    }
  });
});
