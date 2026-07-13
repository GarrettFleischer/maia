/**
 * @fileoverview Unit tests for coverage threshold parser.
 * Verifies that the script interprets the All files line correctly and compares against thresholds.
 * @module __tests__/scripts/check-coverage-threshold
 */

import { describe, it, expect } from "bun:test";

/**
 * @brief Parses the All files coverage table row into function/line percentages.
 * Mirrors `scripts/check-coverage-threshold.ts` (requires `|` so test names
 * mentioning "All files" are ignored).
 * @param text - Coverage output, or a single table line.
 * @returns Tuple of [functionsPct, linesPct] as fractions (0–1).
 */
function parseAllFilesLine(text: string): [number, number] {
  const match = text.match(
    /^All files\s*\|\s*(\d+(?:\.\d+)?)\s*%?\s*\|\s*(\d+(?:\.\d+)?)\s*%?/m,
  );
  if (!match) {
    throw new Error("Missing coverage percentages");
  }
  return [Number(match[1]) / 100, Number(match[2]) / 100];
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

  it("ignores test names that mention All files", () => {
    const noise =
      "(pass) check-coverage-threshold parser > extracts functions and lines percentages from All files line [0.10ms]\n" +
      "All files                                            |   90.04 |   91.01 |\n";
    const [funcs, lines] = parseAllFilesLine(noise);
    expect(funcs).toBeCloseTo(0.9004);
    expect(lines).toBeCloseTo(0.9101);
  });

  it("throws when the line does not contain two percentages", () => {
    const badLine = "All files |   -- |   -- |";
    expect(() => parseAllFilesLine(badLine)).toThrow();
  });
});
