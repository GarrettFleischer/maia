/**
 * @fileoverview Tests for terminal_exec tool backed by the Maia bash-like shell.
 * @module __tests__/lib/tools/terminal.test
 */
import { describe, it, expect } from "bun:test";
import { getAgentDir, getAgentWorkspace } from "@/lib/data-dir";
import { makeTestContext } from "../../helpers/fakes";
import { terminalTool } from "@/lib/tools/terminal";
import type { ToolContext } from "@/lib/tools/types";

function makeToolCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctx = makeTestContext();
  return {
    ...ctx,
    agentId: "maia",
    sessionId: "session-1",
    volumeRoot: getAgentDir("maia"),
    defaultCwd: getAgentWorkspace("maia"),
    ...overrides,
  };
}

describe("terminalTool (Maia shell)", () => {
  it("@brief runs a simple echo command in the agent workspace sandbox", async () => {
    const ctx = makeToolCtx();

    const result = await terminalTool.execute({ cmd: "echo hello" }, ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("@brief uses ~ as the logical current directory and reports it via pwd", async () => {
    const ctx = makeToolCtx();

    const result = await terminalTool.execute({ cmd: "pwd" }, ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("~");
  });

  it("@brief supports simple pipelines via the shell session", async () => {
    const ctx = makeToolCtx();

    const result = await terminalTool.execute({ cmd: "echo foo | cat" }, ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("foo");
  });

  it("@brief truncates very large stdout and stderr", async () => {
    const ctx = makeToolCtx();
    const big = "x".repeat(60 * 1024);

    // Directly exercise truncation by simulating large output from echo.
    const result = await terminalTool.execute(
      { cmd: `echo ${big}` },
      ctx,
    );

    expect(result.stdout.length).toBeLessThanOrEqual(50 * 1024 + 32);
  });

  it("@brief has a tool definition describing the Maia shell", () => {
    const def = terminalTool.toDefinition();
    expect(def.name).toBe("terminal_exec");
    expect(def.description).toContain("bash-like");
    expect(def.parameters).toBeDefined();
  });
});
