/**
 * @fileoverview Maia bash-like shell tool: terminal_exec backed by ShellSession.
 * @module lib/tools/terminal
 *
 * Provides a cross-platform, sandboxed bash-like shell whose ~ maps to the
 * agent workspace, ~/.. to identity, and ~/../.. to the global agents system.
 */
import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import type { ExecResult } from "../types";
import { ShellSession } from "../shell/session";
import { HybridFileSystem, type FsPolicy } from "../shell/fs";
import { getDataDir, getAgentsDir, getAgentDir, getAgentWorkspace } from "../data-dir";

const MAX_OUTPUT = 50 * 1024;

const shellSchema = z.object({
  cmd: z.string().describe("Maia shell command (bash-like syntax)"),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory; omit to use your workspace folder (default). Use relative paths from workspace, e.g. . or subdir.",
    ),
});

function truncate(stdout: string, stderr: string): { stdout: string; stderr: string } {
  return {
    stdout: stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n[truncated]" : stdout,
    stderr: stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n[truncated]" : stderr,
  };
}

function makeFsPolicy(): FsPolicy {
  return {
    isRealPath: () => true,
    isReadOnly: () => false,
  };
}

function makeShellSession(ctx: ToolContext): ShellSession {
  const sandboxRoot = getDataDir();
  const systemRoot = getAgentsDir();
  const identityRoot = getAgentDir(ctx.agentId);
  const workspaceRoot = getAgentWorkspace(ctx.agentId);

  const fs = new HybridFileSystem(
    { sandboxRoot, systemRoot, identityRoot, workspaceRoot },
    ctx.fs,
    makeFsPolicy(),
  );

  return new ShellSession({
    sandboxRoot,
    workspaceRoot,
    identityRoot,
    systemRoot,
    env: {},
    fs,
  });
}

/** Maia bash-like shell tool (all platforms). */
export const terminalTool: Tool<z.infer<typeof shellSchema>, ExecResult> = {
  name: "terminal_exec",
  description:
    "Execute a Maia bash-like shell command. Cross-platform and fully sandboxed: ~ is your workspace folder (agents/<your_id>/workspace), ~/.. is your identity directory, and ~/../.. is the global agents system. Returns { stdout, stderr, exitCode }: exitCode 0 = success. Supports basic bash-like syntax including quoting, environment variables, and simple pipes.",
  schema: shellSchema,
  toDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: zodToJsonSchema(this.schema),
      returns: "object (stdout: string, stderr: string, exitCode: number). exitCode 0 = success.",
    };
  },
  async execute({ cmd: command }, ctx) {
    const session = makeShellSession(ctx);
    const result = await session.runLine(command);
    const { stdout, stderr } = truncate(result.stdout, result.stderr);
    return { stdout, stderr, exitCode: result.exitCode };
  },
};