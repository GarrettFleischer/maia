/**
 * @fileoverview Sandboxed terminal runner. File commands (cd, ls, cat, cp, mv, etc.) are
 * routed through the sandboxed filesystem; other commands run in a subprocess with cwd under sandbox.
 * @module tools/terminal
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { resolveWithinSandbox } from "@/lib/sandbox";
import { createSandboxFs } from "./fs";
import { isFileCommand, runFileCommand } from "./terminal-file-commands";

export type RunResult =
  | { allowed: false; reason: string }
  | {
      allowed: true;
      exitCode: number;
      stdout: string;
      stderr: string;
    };

const BLOCKED_PATTERNS = [
  /\.\.\//,
  /\/etc\//,
  /\/usr\//,
  /[;&|`$(){}]/, // shell metacharacters for spawn path
];

function isAllowed(command: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = command.trim();
  for (const p of BLOCKED_PATTERNS) {
    if (p.test(trimmed)) {
      return { ok: false, reason: "Command not allowed" };
    }
  }
  return { ok: true };
}

/**
 * Creates a terminal runner. File operations (cd, ls, cat, cp, mv, mkdir, rm, pwd, touch)
 * are executed via the sandboxed filesystem. All other commands run in a subprocess with
 * cwd under sandbox.
 */
export function createTerminalRunner(sandboxRoot: string) {
  const root = path.normalize(path.resolve(sandboxRoot));
  const fs = createSandboxFs(root);

  return {
    async run(
      command: string,
      options?: { cwd?: string; timeoutMs?: number }
    ): Promise<RunResult> {
      const cwdRel = (options?.cwd ?? ".").replace(/\\/g, "/");
      const cwdResolved = resolveWithinSandbox(root, cwdRel);
      const cwdForFs = cwdResolved === null ? "." : path.relative(root, cwdResolved).replace(/\\/g, "/");

      if (isFileCommand(command)) {
        const result = runFileCommand(command, cwdForFs, root, fs);
        if (result.handled) {
          return {
            allowed: true,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        }
      }

      const check = isAllowed(command);
      if (!check.ok) {
        return { allowed: false, reason: check.reason };
      }
      const cwd = cwdResolved ?? root;
      return new Promise((resolve) => {
        const proc = spawn(command, [], {
          shell: true,
          cwd,
          timeout: options?.timeoutMs ?? 10_000,
        });
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (d) => (stdout += d.toString()));
        proc.stderr?.on("data", (d) => (stderr += d.toString()));
        proc.on("close", (code) => {
          resolve({
            allowed: true,
            exitCode: code ?? -1,
            stdout,
            stderr,
          });
        });
        proc.on("error", () => {
          resolve({
            allowed: true,
            exitCode: -1,
            stdout,
            stderr: "Process error",
          });
        });
      });
    },
  };
}
