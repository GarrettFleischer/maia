/**
 * @fileoverview Integration tests for sandboxed filesystem tool.
 * @module tests/tools/fs.test
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createSandboxFs,
  type SandboxFs,
} from "@/tools/fs";

describe("sandbox fs", () => {
  let sandboxRoot: string;
  let fsTool: SandboxFs;

  beforeEach(() => {
    sandboxRoot = path.join(process.cwd(), "tmp-sandbox-" + Date.now());
    fs.mkdirSync(sandboxRoot, { recursive: true });
    fs.writeFileSync(path.join(sandboxRoot, "file1.txt"), "hello", "utf-8");
    fs.mkdirSync(path.join(sandboxRoot, "subdir"), { recursive: true });
    fsTool = createSandboxFs(sandboxRoot);
  });

  afterEach(() => {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("list shows contents of root as /", () => {
    const entries = fsTool.list("/");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.some((e) => e.name === "file1.txt")).toBe(true);
    expect(entries.some((e) => e.name === "subdir")).toBe(true);
  });

  it("list shows contents of subdir", () => {
    const entries = fsTool.list("subdir");
    expect(Array.isArray(entries)).toBe(true);
  });

  it("readFile returns file content", () => {
    const content = fsTool.readFile("file1.txt");
    expect(content).toBe("hello");
  });

  it("writeFile creates file and readFile reads it", () => {
    fsTool.writeFile("new.txt", "world");
    const content = fsTool.readFile("new.txt");
    expect(content).toBe("world");
  });

  it("rejects path escaping with ..", () => {
    expect(() => fsTool.readFile("../etc/passwd")).toThrow();
    expect(() => fsTool.list("../../etc")).toThrow();
    expect(() => fsTool.writeFile("../../../tmp/escape", "x")).toThrow();
  });

  it("rejects absolute path outside sandbox", () => {
    expect(() => fsTool.readFile("/etc/passwd")).toThrow();
  });

  it("deleteFile removes file", () => {
    fsTool.deleteFile("file1.txt");
    expect(fsTool.exists("file1.txt")).toBe(false);
  });

  it("deleteFile removes directory recursively", () => {
    fsTool.writeFile("subdir/nested.txt", "x");
    fsTool.deleteFile("subdir");
    expect(fsTool.exists("subdir")).toBe(false);
  });

  it("mkdir creates directory", () => {
    fsTool.mkdir("newdir");
    expect(fsTool.exists("newdir")).toBe(true);
    const entries = fsTool.list("newdir");
    expect(entries.length).toBe(0);
  });

  it("exists returns true for existing path", () => {
    expect(fsTool.exists("file1.txt")).toBe(true);
    expect(fsTool.exists("subdir")).toBe(true);
  });

  it("exists returns false for missing path", () => {
    expect(fsTool.exists("nonexistent")).toBe(false);
  });
});
