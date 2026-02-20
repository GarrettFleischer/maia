/**
 * @fileoverview Routes file-related terminal commands through the sandboxed filesystem.
 * @module tools/terminal-file-commands
 *
 * Parses commands like cd, ls, cat, cp, mv, mkdir, rm, pwd, touch and executes them
 * via SandboxFs so all file access stays inside the sandbox.
 */

import path from "node:path";
import { resolveWithinSandbox } from "@/lib/sandbox";
import type { SandboxFs } from "./fs";

export type FileCommandResult =
  | { handled: false }
  | { handled: true; exitCode: number; stdout: string; stderr: string };

/**
 * Resolves a path argument relative to cwd (or absolute under sandbox). Returns path
 * relative to sandbox root for use with SandboxFs, or null if escape.
 */
function resolvePath(
  sandboxRoot: string,
  cwd: string,
  arg: string
): string | null {
  const requested = arg.startsWith("/")
    ? arg.slice(1).replace(/\\/g, "/")
    : path.join(cwd, arg).replace(/\\/g, "/");
  const resolved = resolveWithinSandbox(sandboxRoot, requested);
  if (resolved === null) return null;
  const rel = path.relative(sandboxRoot, resolved);
  return path.normalize(rel).replace(/\\/g, "/");
}

/**
 * Splits a command string into trimmed parts (simple split on whitespace; no quote handling).
 */
function parseCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * If the command is a file operation, run it via the sandbox fs and return the result.
 * Otherwise return { handled: false }.
 */
export function runFileCommand(
  command: string,
  cwd: string,
  sandboxRoot: string,
  fs: SandboxFs
): FileCommandResult {
  const parts = parseCommand(command);
  if (parts.length === 0) return { handled: false };

  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  const resolve = (arg: string): string | null => resolvePath(sandboxRoot, cwd, arg);

  try {
    switch (cmd) {
      case "pwd": {
        const p = resolve(".") ?? cwd;
        return { handled: true, exitCode: 0, stdout: p || ".", stderr: "" };
      }
      case "cd": {
        const to = args[0] ?? ".";
        const resolved = resolve(to);
        if (resolved === null) {
          return { handled: true, exitCode: 1, stdout: "", stderr: "cd: path not allowed (outside sandbox)" };
        }
        return { handled: true, exitCode: 0, stdout: resolved, stderr: "" };
      }
      case "ls":
      case "dir": {
        const dir = args[0] ?? ".";
        const resolved = resolve(dir);
        if (resolved === null) {
          return { handled: true, exitCode: 1, stdout: "", stderr: "ls: path not allowed" };
        }
        if (!fs.exists(resolved)) {
          return { handled: true, exitCode: 1, stdout: "", stderr: `ls: no such file or directory: ${dir}` };
        }
        try {
          const entries = fs.list(resolved);
          const lines = entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name));
          return { handled: true, exitCode: 0, stdout: lines.join("\n"), stderr: "" };
        } catch {
          return { handled: true, exitCode: 1, stdout: "", stderr: `ls: not a directory: ${dir}` };
        }
      }
      case "cat": {
        if (args.length === 0) {
          return { handled: true, exitCode: 1, stdout: "", stderr: "cat: missing file operand" };
        }
        const out: string[] = [];
        for (const a of args) {
          const resolved = resolve(a);
          if (resolved === null) {
            return { handled: true, exitCode: 1, stdout: "", stderr: `cat: not allowed: ${a}` };
          }
          if (!fs.exists(resolved)) {
            return { handled: true, exitCode: 1, stdout: "", stderr: `cat: no such file: ${a}` };
          }
          out.push(fs.readFile(resolved));
        }
        return { handled: true, exitCode: 0, stdout: out.join(""), stderr: "" };
      }
      case "cp": {
        if (args.length < 2) {
          return { handled: true, exitCode: 1, stdout: "", stderr: "cp: missing source or destination" };
        }
        const src = resolve(args[0]);
        const dest = resolve(args[1]);
        if (src === null || dest === null) {
          return { handled: true, exitCode: 1, stdout: "", stderr: "cp: path not allowed" };
        }
        if (!fs.exists(src)) {
          return { handled: true, exitCode: 1, stdout: "", stderr: `cp: no such file: ${args[0]}` };
        }
        const content = fs.readFile(src);
        fs.writeFile(dest, content);
        return { handled: true, exitCode: 0, stdout: "", stderr: "" };
      }
      case "mv": {
        if (args.length < 2) {
          return { handled: true, exitCode: 1, stdout: "", stderr: "mv: missing source or destination" };
        }
        const mvSrc = resolve(args[0]);
        const mvDest = resolve(args[1]);
        if (mvSrc === null || mvDest === null) {
          return { handled: true, exitCode: 1, stdout: "", stderr: "mv: path not allowed" };
        }
        if (!fs.exists(mvSrc)) {
          return { handled: true, exitCode: 1, stdout: "", stderr: `mv: no such file: ${args[0]}` };
        }
        try {
          const mvContent = fs.readFile(mvSrc);
          fs.writeFile(mvDest, mvContent);
          fs.deleteFile(mvSrc);
        } catch {
          return { handled: true, exitCode: 1, stdout: "", stderr: "mv: source is a directory (only files supported)" };
        }
        return { handled: true, exitCode: 0, stdout: "", stderr: "" };
      }
      case "mkdir": {
        if (args.length === 0) {
          return { handled: true, exitCode: 1, stdout: "", stderr: "mkdir: missing operand" };
        }
        for (const a of args) {
          const resolved = resolve(a);
          if (resolved === null) {
            return { handled: true, exitCode: 1, stdout: "", stderr: `mkdir: path not allowed: ${a}` };
          }
          fs.mkdir(resolved);
        }
        return { handled: true, exitCode: 0, stdout: "", stderr: "" };
      }
      case "rm": {
        const rmRecursive = args[0] === "-r" || args[0] === "-rf" || args[0] === "-fr";
        const rmPaths = rmRecursive ? args.slice(1) : args;
        if (rmPaths.length === 0) {
          return { handled: true, exitCode: 1, stdout: "", stderr: "rm: missing operand" };
        }
        for (const a of rmPaths) {
          const resolved = resolve(a);
          if (resolved === null) {
            return { handled: true, exitCode: 1, stdout: "", stderr: `rm: path not allowed: ${a}` };
          }
          if (!fs.exists(resolved)) {
            return { handled: true, exitCode: 1, stdout: "", stderr: `rm: no such file: ${a}` };
          }
          fs.deleteFile(resolved);
        }
        return { handled: true, exitCode: 0, stdout: "", stderr: "" };
      }
      case "touch": {
        if (args.length === 0) {
          return { handled: true, exitCode: 1, stdout: "", stderr: "touch: missing operand" };
        }
        for (const a of args) {
          const resolved = resolve(a);
          if (resolved === null) {
            return { handled: true, exitCode: 1, stdout: "", stderr: `touch: path not allowed: ${a}` };
          }
          if (fs.exists(resolved)) {
            const existing = fs.readFile(resolved);
            fs.writeFile(resolved, existing);
          } else {
            fs.writeFile(resolved, "");
          }
        }
        return { handled: true, exitCode: 0, stdout: "", stderr: "" };
      }
      default:
        return { handled: false };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { handled: true, exitCode: 1, stdout: "", stderr: msg };
  }
}

/**
 * Returns true if the command looks like a file command we can handle.
 */
export function isFileCommand(command: string): boolean {
  const parts = parseCommand(command);
  if (parts.length === 0) return false;
  const cmd = parts[0].toLowerCase();
  return [
    "pwd", "cd", "ls", "dir", "cat", "cp", "mv", "mkdir", "rm", "touch",
  ].includes(cmd);
}
