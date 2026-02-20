/**
 * @fileoverview Integration tests for sandboxed terminal tool.
 * @module tests/tools/terminal.test
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { createTerminalRunner } from "@/tools/terminal";

describe("terminal runner", () => {
  const sandboxRoot = path.join(process.cwd(), "tmp-terminal-" + Date.now());
  fs.mkdirSync(sandboxRoot, { recursive: true });
  const runner = createTerminalRunner(sandboxRoot);

  afterAll(() => {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("runs safe command and returns output", async () => {
    const result = await runner.run("echo hello");
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("cd .. is handled by sandbox fs and returns error (escape)", async () => {
    const result = await runner.run("cd ..");
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not allowed");
  });

  it("cat on path under sandbox is handled by sandbox fs", async () => {
    fs.writeFileSync(path.join(sandboxRoot, "foo.txt"), "content", "utf-8");
    const result = await runner.run("cat foo.txt");
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("content");
  });

  it("cat on non-existent path returns error", async () => {
    const result = await runner.run("cat /nonexistent");
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no such file|not allowed/);
  });
});
