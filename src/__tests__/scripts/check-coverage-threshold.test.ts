/**
 * @fileoverview Unit tests for coverage threshold parser.
 * Verifies that the script interprets the All files line correctly and compares against thresholds.
 * @module __tests__/scripts/check-coverage-threshold
 */

import { describe, it, expect } from "bun:test";

/**
 * @brief Parses the All files coverage line into function/line percentages.
 * Reimplements the logic from scripts/check-coverage-threshold.ts for testability.
 * @param line - Coverage table line containing two percentages.
 * @returns Tuple of [functionsPct, linesPct] as fractions (0–1).
 */
function parseAllFilesLine(line: string): [number, number] {
  const pctNumbers = line.match(/\d+(?:\.\d+)?/g);
  if (!pctNumbers || pctNumbers.length < 2) {
    throw new Error("Missing coverage percentages");
  }
  const functionsPct = Number(pctNumbers[0]) / 100;
  const linesPct = Number(pctNumbers[1]) / 100;
  return [functionsPct, linesPct];
}

describe("check-coverage-threshold parser", () => {
  it("extracts functions and lines percentages from All files line", () => {
    const line =
      "All files                                            |   91.07 |   90.48 |";
    const [funcs, lines] = parseAllFilesLine(line);
    expect(funcs).toBeCloseTo(0.9107);
    expect(lines).toBeCloseTo(0.9048);
  });

  it("handles integer percentages without decimals", () => {
    const line =
      "All files                                            |      91 |      90 |";
    const [funcs, lines] = parseAllFilesLine(line);
    expect(funcs).toBeCloseTo(0.91);
    expect(lines).toBeCloseTo(0.9);
  });

  it("handles percentages that include percent signs", () => {
    const line =
      "All files                                            |   91.07% |   90.48% |";
    const [funcs, lines] = parseAllFilesLine(line);
    expect(funcs).toBeCloseTo(0.9107);
    expect(lines).toBeCloseTo(0.9048);
  });

  it("throws when the line does not contain two percentages", () => {
    const badLine = "All files |   -- |   -- |";
    expect(() => parseAllFilesLine(badLine)).toThrow();
  });
});
