/**
 * @fileoverview Enforces minimum 90% overall line and function coverage.
 * Bun's coverageThreshold is per-file; we want overall ≥90% while ignoring
 * network/LLM-only code (excluded via coveragePathIgnorePatterns in bunfig.toml).
 * @module scripts/check-coverage
 */

import { spawn } from "node:child_process";

const MIN_LINES = 90;
const MIN_FUNCS = 90;

/**
 * Runs `bun test --coverage`, streams output, then parses the "All files" line
 * and exits with 1 if either lines or functions are below MIN_*.
 * @brief Runs coverage and enforces overall threshold
 */
async function main(): Promise<void> {
  const proc = spawn("bun", ["test", "--coverage"], {
    stdio: ["inherit", "pipe", "pipe"],
    shell: true,
  });

  const chunks: Buffer[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    process.stdout.write(chunk);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    process.stderr.write(chunk);
  });

  const code = await new Promise<number | null>((resolve) => {
    proc.on("close", resolve);
  });

  if (code !== 0) {
    process.exit(code ?? 1);
  }

  const out = Buffer.concat(chunks).toString("utf8");
  // Table line: "All files ... | 96.93 | 96.73 |" (funcs then lines); Bun may use stdout or stderr
  const allFilesMatch = out.match(/All files[\s\S]*?\|\s*([\d.]+)\s+\|\s*([\d.]+)/);
  if (!allFilesMatch) {
    console.error("check-coverage: could not find 'All files' line in coverage output");
    process.exit(1);
  }

  const funcs = parseFloat(allFilesMatch[1]);
  const lines = parseFloat(allFilesMatch[2]);

  if (funcs < MIN_FUNCS || lines < MIN_LINES) {
    console.error(
      `check-coverage: overall coverage ${funcs}% functions, ${lines}% lines is below ${MIN_FUNCS}%`
    );
    process.exit(1);
  }

  console.log(`check-coverage: overall coverage ${funcs}% functions, ${lines}% lines (≥${MIN_FUNCS}% required)`);
}

main();
