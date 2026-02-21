/**
 * @fileoverview Tests for terminal_exec tool (process runner DI, truncation, exit code).
 * @module __tests__/lib/tools/terminal.test
 */
import { describe, it, expect, beforeEach } from "bun:test";
import path from "path";
import { makeTestContext, FakeProcessRunner } from "../../helpers/fakes";
import { terminalTool } from "@/lib/tools/terminal";
import type { ToolContext } from "@/lib/tools/types";

const WORKSPACE_ROOT = path.join(process.cwd(), "data", "workspace");

function makeToolCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctx = makeTestContext();
  return {
    ...ctx,
    agentId: "maia",
    sessionId: "session-1",
    volumeRoot: path.join(WORKSPACE_ROOT, "maia"),
    ...overrides,
  };
}

describe("terminalTool", () => {
  it("builds docker exec command with container and workdir from context", async () => {
    const runner = new FakeProcessRunner();
    runner.setResult({ stdout: "ok", stderr: "", exitCode: 0 });
    const ctx = makeToolCtx({
      processRunner: runner,
      sandboxContainerName: "my-container",
    });

    await terminalTool.execute(
      { command: "echo hello", cwd: "/workspace/app" },
      ctx
    );

    expect(runner.lastExec).not.toBeNull();
    expect(runner.lastExec?.cmd).toContain("my-container");
    expect(runner.lastExec?.cmd).toContain("/workspace/app");
    expect(runner.lastExec?.cmd).toContain("echo hello");
    expect(runner.lastExec?.opts?.timeout).toBe(30_000);
  });

  it("uses default container name when sandboxContainerName is not set", async () => {
    const runner = new FakeProcessRunner();
    runner.setResult({ stdout: "", stderr: "", exitCode: 0 });
    const ctx = makeToolCtx({
      processRunner: runner,
      sandboxContainerName: undefined,
    });

    await terminalTool.execute({ command: "true" }, ctx);

    expect(runner.lastExec?.cmd).toContain("maia-sandbox");
  });

  it("returns stdout, stderr and exitCode from process runner", async () => {
    const runner = new FakeProcessRunner();
    runner.setResult({
      stdout: "Hello\n",
      stderr: "warn\n",
      exitCode: 0,
    });
    const ctx = makeToolCtx({ processRunner: runner });

    const result = await terminalTool.execute({ command: "echo Hello" }, ctx);

    expect(result.stdout).toBe("Hello\n");
    expect(result.stderr).toBe("warn\n");
    expect(result.exitCode).toBe(0);
  });

  it("propagates non-zero exit code", async () => {
    const runner = new FakeProcessRunner();
    runner.setResult({
      stdout: "",
      stderr: "command not found",
      exitCode: 127,
    });
    const ctx = makeToolCtx({ processRunner: runner });

    const result = await terminalTool.execute({ command: "badcmd" }, ctx);

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("command not found");
  });

  it("truncates stdout over 50KB and appends [truncated]", async () => {
    const runner = new FakeProcessRunner();
    const big = "x".repeat(60 * 1024);
    runner.setResult({ stdout: big, stderr: "", exitCode: 0 });
    const ctx = makeToolCtx({ processRunner: runner });

    const result = await terminalTool.execute({ command: "cat big" }, ctx);

    expect(result.stdout.length).toBeLessThanOrEqual(50 * 1024 + 20);
    expect(result.stdout).toContain("[truncated]");
  });

  it("truncates stderr over 50KB", async () => {
    const runner = new FakeProcessRunner();
    const big = "e".repeat(60 * 1024);
    runner.setResult({ stdout: "", stderr: big, exitCode: 1 });
    const ctx = makeToolCtx({ processRunner: runner });

    const result = await terminalTool.execute({ command: "fail" }, ctx);

    expect(result.stderr.length).toBeLessThanOrEqual(50 * 1024 + 20);
    expect(result.stderr).toContain("[truncated]");
  });

  it("has correct tool definition", () => {
    const def = terminalTool.toDefinition();
    expect(def.name).toBe("terminal_exec");
    expect(def.description).toContain("sandbox");
    expect(def.parameters).toBeDefined();
  });
});
