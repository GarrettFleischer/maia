/**
 * @fileoverview Tests for git-based backups of the Maia data directory.
 * @module __tests__/lib/data-backup.test
 */

import { describe, it, expect } from "bun:test";
import type { AppContext } from "@/lib/context";
import { getDataDir } from "@/lib/data-dir";
import { runDataBackup } from "@/lib/data-backup";
import { FakeProcessRunner, makeTestContext } from "../helpers/fakes";

interface RecordedCall {
  cmd: string;
  cwd?: string;
}

describe("runDataBackup", () => {
  it("skips commit when there are no changes", async () => {
    const runner = new FakeProcessRunner();
    const calls: RecordedCall[] = [];

    runner.onExec(async (cmd, opts) => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd.startsWith("git status")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const ctx: AppContext = makeTestContext({ processRunner: runner });

    await runDataBackup(ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toContain("git status --porcelain");
    expect(calls[0]?.cwd).toBe(getDataDir());
  });

  it("creates a commit when there are changes", async () => {
    const runner = new FakeProcessRunner();
    const calls: RecordedCall[] = [];

    runner.onExec(async (cmd, opts) => {
      calls.push({ cmd, cwd: opts?.cwd });

      if (cmd.startsWith("git status")) {
        return { stdout: " M agents/maia/PERSONA.md\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "git add -A") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd.startsWith('git commit -m "heartbeat backup')) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      throw new Error(`Unexpected command: ${cmd}`);
    });

    const ctx: AppContext = makeTestContext({ processRunner: runner });

    await runDataBackup(ctx);

    expect(calls.length).toBe(3);
    const [statusCall, addCall, commitCall] = calls;

    const dataDir = getDataDir();
    expect(statusCall.cmd).toContain("git status --porcelain");
    expect(statusCall.cwd).toBe(dataDir);

    expect(addCall.cmd).toBe("git add -A");
    expect(addCall.cwd).toBe(dataDir);

    expect(commitCall.cmd.startsWith('git commit -m "heartbeat backup')).toBe(true);
    expect(commitCall.cwd).toBe(dataDir);
  });

  it("no-ops when data dir is not a git repository", async () => {
    const runner = new FakeProcessRunner();
    const calls: RecordedCall[] = [];

    runner.onExec(async (cmd, opts) => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd.startsWith("git status")) {
        return {
          stdout: "",
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
          exitCode: 128,
        };
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const ctx: AppContext = makeTestContext({ processRunner: runner });

    await runDataBackup(ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toContain("git status --porcelain");
  });
});

