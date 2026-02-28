import path from "path";
import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import type { ExecResult } from "../types";

const TERMINAL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 50 * 1024;

const schema = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory within /workspace (defaults to /workspace)"),
});

/**
 * Resolve cwd for local execution: map Docker /workspace[/...] or relative paths to volumeRoot[/...].
 * Sandbox: ensures the resolved path stays under volumeRoot (no escape).
 */
function localCwd(cwd: string | undefined, volumeRoot: string): string {
  const inner = (cwd ?? "/workspace").replace(/^\/workspace\/?/, "") || ".";
  const resolved = path.resolve(volumeRoot, inner);
  const normalizedRoot = path.normalize(volumeRoot).replace(/\/$/, "") + path.sep;
  const normalizedResolved = path.normalize(resolved) + (resolved.endsWith(path.sep) ? "" : path.sep);
  if (!normalizedResolved.startsWith(normalizedRoot)) {
    return volumeRoot;
  }
  return resolved;
}

/** On Windows, convert common bash-isms so the command can run in PowerShell. */
function toPowerShellIfNeeded(command: string): { command: string; shell: string } {
  if (process.platform !== "win32") {
    return { command, shell: "bash" };
  }
  let out = command
    .replace(/\s*&&\s*/g, "; ")
    .replace(/\s*\|\|\s*/g, "; if ($?) { ");
  if (command.includes("||")) out += " }";
  return { command: out, shell: "powershell" };
}

export const terminalTool: Tool<z.infer<typeof schema>, ExecResult> = {
  name: "terminal_exec",
  description:
    "Execute a shell command. Uses the sandbox container when one is configured (SANDBOX_CONTAINER_NAME); otherwise runs in the agent workspace on the host.",
  schema,
  toDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: zodToJsonSchema(schema),
      returns: "object (stdout: string, stderr: string, exitCode: number)",
    };
  },
  async execute({ command, cwd }, ctx) {
    const useSandbox = ctx.sandboxContainerName != null && ctx.sandboxContainerName !== "";

    if (useSandbox) {
      const container = ctx.sandboxContainerName ?? "maia-sandbox";
      const workdir = cwd ?? "/workspace";
      const dockerCmd = [
        "docker",
        "exec",
        "--workdir",
        workdir,
        container,
        "bash",
        "-c",
        command,
      ]
        .map((arg) => `"${arg.replace(/"/g, '\\"')}"`)
        .join(" ");
      const { stdout, stderr, exitCode } = await ctx.processRunner.exec(dockerCmd, {
        timeout: TERMINAL_TIMEOUT_MS,
      });
      return {
        stdout: stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n[truncated]" : stdout,
        stderr: stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n[truncated]" : stderr,
        exitCode,
      };
    }

    const workdir = localCwd(cwd, ctx.volumeRoot);
    const { command: translated, shell } = toPowerShellIfNeeded(command);
    const localCmd =
      shell === "powershell"
        ? `powershell -NoProfile -Command ${JSON.stringify(translated)}`
        : `bash -c ${JSON.stringify(translated)}`;
    const { stdout, stderr, exitCode } = await ctx.processRunner.exec(localCmd, {
      timeout: TERMINAL_TIMEOUT_MS,
      cwd: workdir,
    });
    return {
      stdout: stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n[truncated]" : stdout,
      stderr: stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n[truncated]" : stderr,
      exitCode,
    };
  },
};
