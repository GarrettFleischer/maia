import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import type { ExecResult } from "../types";

const execAsync = promisify(exec);
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
  async execute({ command, cwd }, _ctx) {
    const SANDBOX_CONTAINER = process.env.SANDBOX_CONTAINER_NAME ?? "maia-sandbox";
    const workdir = cwd ?? "/workspace";

    const dockerCmd = [
      "docker", "exec",
      "--workdir", workdir,
      SANDBOX_CONTAINER,
      "bash", "-c", command,
    ].map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(" ");

    try {
      const { stdout, stderr } = await execAsync(dockerCmd, {
        timeout: TERMINAL_TIMEOUT_MS,
      });
      return {
        stdout: stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n[truncated]" : stdout,
        stderr: stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n[truncated]" : stderr,
        exitCode: 0,
      };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: (e.stdout ?? "").slice(0, MAX_OUTPUT),
        stderr: (e.stderr ?? String(err)).slice(0, MAX_OUTPUT),
        exitCode: e.code ?? 1,
      };
    }
  },
};
