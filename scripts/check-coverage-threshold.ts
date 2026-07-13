/**
 * @fileoverview Enforces overall (app-wide) coverage thresholds by parsing
 * the "All files" line from `bun test --coverage` output. Thresholds apply
 * to the aggregate only, not per-file.
 * @module scripts/check-coverage-threshold
 */

import { spawnSync } from "child_process";
import path from "path";

const DEFAULT_LINES = 0.9;
const DEFAULT_FUNCTIONS = 0.9;

const linesThreshold =
  typeof process.env.COVERAGE_LINES_THRESHOLD !== "undefined"
    ? Number(process.env.COVERAGE_LINES_THRESHOLD)
    : DEFAULT_LINES;
const functionsThreshold =
  typeof process.env.COVERAGE_FUNCTIONS_THRESHOLD !== "undefined"
    ? Number(process.env.COVERAGE_FUNCTIONS_THRESHOLD)
    : DEFAULT_FUNCTIONS;

const root = path.resolve(process.cwd());
const result = spawnSync("bun", ["test", "--coverage"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"],
});

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
console.log(stdout);
if (stderr) console.error(stderr);
// Parse from combined output: on some platforms the coverage table is written to stderr
const combined = stdout + "\n" + stderr;

if (result.status !== 0) {
  process.exit(result.status);
}

// Parse the coverage table row
// "All files | 95.85 | 98.90 |" (Funcs %, Lines %). Require pipes so test
// names that mention "All files" (e.g. "... from All files line [0.10ms]")
// are not mistaken for the aggregate row. May appear on stdout or stderr.
const allFilesMatch = combined.match(
  /^All files\s*\|\s*(\d+(?:\.\d+)?)\s*%?\s*\|\s*(\d+(?:\.\d+)?)\s*%?/m,
);
if (!allFilesMatch) {
  console.error(
    "check-coverage-threshold: could not find 'All files' line with two percentages in coverage output",
  );
  process.exit(1);
}

const functionsPct = Number(allFilesMatch[1]) / 100;
const linesPct = Number(allFilesMatch[2]) / 100;

const failed: string[] = [];
if (functionsPct < functionsThreshold) {
  failed.push(
    `functions ${(functionsPct * 100).toFixed(2)}% < ${(functionsThreshold * 100).toFixed(0)}%`,
  );
}
if (linesPct < linesThreshold) {
  failed.push(
    `lines ${(linesPct * 100).toFixed(2)}% < ${(linesThreshold * 100).toFixed(0)}%`,
  );
}

if (failed.length > 0) {
  console.error(
    `Coverage threshold (overall app) not met: ${failed.join("; ")}`,
  );
  process.exit(1);
}

process.exit(0);
