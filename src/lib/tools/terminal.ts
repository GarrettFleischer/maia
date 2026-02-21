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

export const terminalTool: Tool<z.infer<typeof schema>, ExecResult> = {
  name: "terminal_exec",
  description: "Execute a shell command inside the sandbox container.",
  schema,
  toDefinition() {
    return { name: this.name, description: this.description, parameters: zodToJsonSchema(schema) };
  },
  async execute({ command, cwd }, ctx) {
    const container = ctx.sandboxContainerName ?? "maia-sandbox";
    const workdir = cwd ?? "/workspace";

    const dockerCmd = [
      "docker", "exec",
      "--workdir", workdir,
      container,
      "bash", "-c", command,
    ].map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(" ");

    const { stdout, stderr, exitCode } = await ctx.processRunner.exec(dockerCmd, {
      timeout: TERMINAL_TIMEOUT_MS,
    });
    return {
      stdout: stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n[truncated]" : stdout,
      stderr: stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n[truncated]" : stderr,
      exitCode,
    };
  },
};
