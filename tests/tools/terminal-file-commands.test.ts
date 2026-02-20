/**
 * @fileoverview Tests for file-command routing (cd, ls, cat, cp, mv, mkdir, rm, pwd, touch).
 * @module tests/tools/terminal-file-commands.test
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSandboxFs } from "@/tools/fs";
import {
  isFileCommand,
  runFileCommand,
} from "@/tools/terminal-file-commands";

describe("terminal file commands", () => {
  let sandboxRoot: string;

  beforeEach(() => {
    sandboxRoot = path.join(process.cwd(), "tmp-term-fs-" + Date.now());
    fs.mkdirSync(sandboxRoot, { recursive: true });
    fs.writeFileSync(path.join(sandboxRoot, "a.txt"), "hello", "utf-8");
    fs.mkdirSync(path.join(sandboxRoot, "dir1"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("isFileCommand identifies cd ls cat cp mv mkdir rm pwd touch", () => {
    expect(isFileCommand("cd x")).toBe(true);
    expect(isFileCommand("ls")).toBe(true);
    expect(isFileCommand("cat file")).toBe(true);
    expect(isFileCommand("pwd")).toBe(true);
    expect(isFileCommand("mkdir d")).toBe(true);
    expect(isFileCommand("rm x")).toBe(true);
    expect(isFileCommand("touch x")).toBe(true);
    expect(isFileCommand("echo hello")).toBe(false);
  });

  it("pwd returns cwd", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("pwd", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(".");
    }
  });

  it("ls lists directory via sandbox", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("ls .", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("a.txt");
      expect(r.stdout).toContain("dir1");
    }
  });

  it("cat reads file via sandbox", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("cat a.txt", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("hello");
    }
  });

  it("cd resolves path and returns new path", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("cd dir1", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toContain("dir1");
    }
  });

  it("cd .. from sandbox root is rejected (escape)", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("cd ..", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("not allowed");
    }
  });

  it("cp copies file via sandbox", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("cp a.txt b.txt", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) expect(r.exitCode).toBe(0);
    expect(fsTool.exists("b.txt")).toBe(true);
    expect(fsTool.readFile("b.txt")).toBe("hello");
  });

  it("mkdir creates directory via sandbox", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("mkdir newdir", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) expect(r.exitCode).toBe(0);
    expect(fsTool.exists("newdir")).toBe(true);
  });

  it("rm removes file via sandbox", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("rm a.txt", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) expect(r.exitCode).toBe(0);
    expect(fsTool.exists("a.txt")).toBe(false);
  });

  it("touch creates empty file", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("touch newfile.txt", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) expect(r.exitCode).toBe(0);
    expect(fsTool.exists("newfile.txt")).toBe(true);
    expect(fsTool.readFile("newfile.txt")).toBe("");
  });

  it("mv moves file via sandbox", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    fs.writeFileSync(path.join(sandboxRoot, "moveme.txt"), "data", "utf-8");
    const r = runFileCommand("mv moveme.txt moved.txt", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) expect(r.exitCode).toBe(0);
    expect(fsTool.exists("moveme.txt")).toBe(false);
    expect(fsTool.readFile("moved.txt")).toBe("data");
  });

  it("rm -r removes directory", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    fsTool.mkdir("todir");
    fsTool.writeFile("todir/f.txt", "x");
    const r = runFileCommand("rm -r todir", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) expect(r.exitCode).toBe(0);
    expect(fsTool.exists("todir")).toBe(false);
  });

  it("cat multiple files concatenates", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("cat a.txt a.txt", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("hellohello");
    }
  });

  it("ls on file returns not a directory", () => {
    const fsTool = createSandboxFs(sandboxRoot);
    const r = runFileCommand("ls a.txt", ".", sandboxRoot, fsTool);
    expect(r.handled).toBe(true);
    if (r.handled) {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/not a directory/);
    }
  });
});
