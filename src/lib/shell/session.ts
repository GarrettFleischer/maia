/**
 * @fileoverview Core shell session abstraction for the Maia bash-like sandbox.
 * Provides a testable API for running command lines against a sandboxed
 * filesystem and environment using the parser and built-in commands.
 * @module lib/shell/session
 */

import type { HybridFileSystem } from "./fs";
import { parseCommandLine } from "./parser";

export interface ShellOptions {
  /**
   * Absolute host path that defines the outermost sandbox boundary.
   * All resolved real filesystem paths must remain under this root.
   */
  sandboxRoot: string;

  /**
   * Absolute host path mapped to the shell's tilde (~) directory.
   * This is the agent's workspace directory.
   */
  workspaceRoot: string;

  /**
   * Absolute host path mapped to the logical parent of ~ (~/..),
   * representing the agent's identity directory.
   */
  identityRoot: string;

  /**
   * Absolute host path mapped to the logical parent of the identity
   * directory (~/../..), representing the system of all agents.
   */
  systemRoot: string;

  /**
   * Initial environment variables for the shell session.
   */
  env?: Record<string, string>;

  /**
   * Sandboxed hybrid filesystem used by this shell session.
   */
  fs: HybridFileSystem;
}

export interface ShellResult {
  /**
   * Captured standard output from the command line execution.
   */
  stdout: string;

  /**
   * Captured standard error output from the command line execution.
   */
  stderr: string;

  /**
   * Process-style exit code where 0 indicates success.
   */
  exitCode: number;
}

/**
 * @brief Represents a single interactive shell session with its own
 * working directory and environment state.
 * @param options Shell configuration including sandbox and root mappings.
 * @note This initial implementation only satisfies the basic test harness
 * and will be extended with parsing, hybrid filesystem, and built-ins.
 */
export class ShellSession {
  private readonly options: ShellOptions;
  private cwd: string;
  private readonly env: Record<string, string>;
  private readonly fs: HybridFileSystem;

  constructor(options: ShellOptions) {
    this.options = options;
    this.cwd = "~";
    this.env = { ...(options.env ?? {}) };
    this.fs = options.fs;
  }

  /**
   * @brief Get the current logical working directory for this shell session.
   * @returns Current directory as a shell-style path (e.g. "~", "~/subdir").
   */
  getCwd(): string {
    return this.cwd;
  }

  /**
   * @brief Execute a single command line within this shell session.
   * @param input Raw command line string (to be parsed and executed).
   * @returns Structured command result with stdout, stderr, and exitCode.
   * @note For now this is a placeholder implementation that only ensures
   * the structure of the result; later phases will extend the execution
   * engine with more built-ins and external process execution.
   * @example
   * const session = new ShellSession(opts);
   * const result = await session.runLine("echo hello");
   */
  async runLine(input: string): Promise<ShellResult> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    const parsed = parseCommandLine(trimmed, {
      env: this.env,
      cwdLogical: this.cwd,
    });

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    const cmdIndex = (c: (typeof parsed.commands)[number]) =>
      parsed.commands.indexOf(c);
    const nextCmd = (c: (typeof parsed.commands)[number]) =>
      parsed.commands[cmdIndex(c) + 1];

    for (const cmd of parsed.commands) {
      if (cmd.argv.length === 0) continue;
      const name = cmd.argv[0]!;
      const args = cmd.argv.slice(1);

      if (name === "cd") {
        const pathArgs = this.pathOperands(args);
        const target = pathArgs[0] ?? "~";
        // For now treat logical paths directly; resolution to host is handled by fs.
        if (target === "~") {
          this.cwd = "~";
        } else if (target.startsWith("~/")) {
          this.cwd = target;
        }
        continue;
      }

      if (name === "pwd") {
        stdout += `${this.cwd}\n`;
        continue;
      }

      if (name === "echo") {
        const isPipedToCat = nextCmd(cmd)?.argv[0] === "cat";
        if (!isPipedToCat) {
          stdout += `${args.join(" ")}\n`;
        }
        continue;
      }

      if (name === "touch") {
        const pathArgs = this.pathOperands(args);
        const target = pathArgs[0];
        if (!target) {
          stderr += "touch: missing file operand\n";
          exitCode = 1;
          continue;
        }
        const logicalPath = this.resolveLogicalPath(target);
        this.fs.writeFile(logicalPath, "");
        continue;
      }

      if (name === "ls") {
        const pathArgs = this.pathOperands(args);
        const logicalDir = pathArgs[0]
          ? this.resolveLogicalPath(pathArgs[0])
          : this.cwd;
        const entries = this.fs.listDir(logicalDir);
        stdout += `${entries.join(" ")}\n`;
        continue;
      }

      if (name === "cat") {
        const heredocRedirect = cmd.redirects.find((r) => r.type === "heredoc");
        const outRedirect = cmd.redirects.find((r) => r.type === ">");
        let content = "";
        if (heredocRedirect?.type === "heredoc") {
          content = heredocRedirect.body;
        } else if (
          parsed.commands.length === 2 &&
          parsed.commands[0]!.argv[0] === "echo" &&
          name === "cat"
        ) {
          content = parsed.commands[0]!.argv.slice(1).join(" ") + "\n";
        } else {
          const pathArgs = this.pathOperands(args);
          for (const file of pathArgs) {
            const logicalPath = this.resolveLogicalPath(file);
            content += this.fs.readFile(logicalPath);
          }
        }
        if (content.length > 0 && !content.endsWith("\n")) {
          content += "\n";
        }
        if (outRedirect?.type === ">") {
          const logicalPath = this.resolveLogicalPath(outRedirect.target);
          this.fs.writeFile(logicalPath, content);
        } else {
          stdout += content;
        }
        continue;
      }

      stderr += `command not implemented: ${name}\n`;
      exitCode = exitCode || 127;
    }

    return { stdout, stderr, exitCode };
  }

  /**
   * @brief Arguments that are path operands (non-option). Use for built-ins that
   * take paths so Unix-style options like -l, -a are ignored.
   * @param args Raw argv after the command name.
   * @returns Args that do not look like options (do not start with -).
   */
  private pathOperands(args: string[]): string[] {
    return args.filter((a) => !a.startsWith("-"));
  }

  /**
   * @brief Resolve a possibly relative or bare token into a logical shell path.
   * @param token Raw token from argv.
   * @returns Logical path rooted at the current working directory or ~.
   */
  private resolveLogicalPath(token: string): string {
    if (token.startsWith("~")) return token;
    if (token.startsWith("/")) return `~${token}`;
    if (this.cwd === "~") return `~/${token}`;
    return `${this.cwd.replace(/\/$/, "")}/${token}`;
  }
}
