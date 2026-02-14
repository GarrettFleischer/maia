/**
 * @fileoverview Integration tests for the real filesystem adapter.
 * @module tests/integration/adapters/filesystem
 *
 * @note Uses a real temp directory on disk. All operations hit the real filesystem.
 * Cleans up the temp directory in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsNative from "node:fs/promises";
import { createRealFileSystem } from "../../../src/adapters/filesystem.js";

describe("Real FileSystem adapter", () => {
  const tmpRoot = path.join(os.tmpdir(), `maia-fs-test-${Date.now()}`);
  const fs = createRealFileSystem();

  beforeAll(async () => {
    await fsNative.mkdir(tmpRoot, { recursive: true });
  });

  afterAll(async () => {
    await fsNative.rm(tmpRoot, { recursive: true, force: true });
  });

  // ── writeFile / readFile roundtrip ───────────────────────────────

  it("should write and read a file", async () => {
    const filePath = path.join(tmpRoot, "hello.txt");
    await fs.writeFile(filePath, "Hello, Maia!");
    const content = await fs.readFile(filePath);
    expect(content).toBe("Hello, Maia!");
  });

  it("should overwrite an existing file", async () => {
    const filePath = path.join(tmpRoot, "overwrite.txt");
    await fs.writeFile(filePath, "first");
    await fs.writeFile(filePath, "second");
    const content = await fs.readFile(filePath);
    expect(content).toBe("second");
  });

  it("should throw when reading a non-existent file", async () => {
    const filePath = path.join(tmpRoot, "does-not-exist.txt");
    await expect(fs.readFile(filePath)).rejects.toThrow();
  });

  // ── appendFile ───────────────────────────────────────────────────

  it("should append to an existing file", async () => {
    const filePath = path.join(tmpRoot, "append.txt");
    await fs.writeFile(filePath, "line1\n");
    await fs.appendFile(filePath, "line2\n");
    const content = await fs.readFile(filePath);
    expect(content).toBe("line1\nline2\n");
  });

  it("should create file if appending to non-existent path", async () => {
    const filePath = path.join(tmpRoot, "append-new.txt");
    await fs.appendFile(filePath, "created by append");
    const content = await fs.readFile(filePath);
    expect(content).toBe("created by append");
  });

  // ── exists ───────────────────────────────────────────────────────

  it("should return true for an existing file", async () => {
    const filePath = path.join(tmpRoot, "exists-check.txt");
    await fs.writeFile(filePath, "yes");
    expect(await fs.exists(filePath)).toBe(true);
  });

  it("should return false for a non-existent path", async () => {
    const filePath = path.join(tmpRoot, "nope.txt");
    expect(await fs.exists(filePath)).toBe(false);
  });

  // ── mkdir ────────────────────────────────────────────────────────

  it("should create a directory", async () => {
    const dirPath = path.join(tmpRoot, "newdir");
    await fs.mkdir(dirPath);
    expect(await fs.exists(dirPath)).toBe(true);
  });

  it("should create nested directories", async () => {
    const dirPath = path.join(tmpRoot, "a", "b", "c");
    await fs.mkdir(dirPath);
    expect(await fs.exists(dirPath)).toBe(true);
  });

  // ── readDir ──────────────────────────────────────────────────────

  it("should list directory contents", async () => {
    const dirPath = path.join(tmpRoot, "listme");
    await fs.mkdir(dirPath);
    await fs.writeFile(path.join(dirPath, "one.txt"), "1");
    await fs.writeFile(path.join(dirPath, "two.txt"), "2");
    const entries = await fs.readDir(dirPath);
    expect(entries.sort()).toEqual(["one.txt", "two.txt"]);
  });

  it("should throw when reading a non-existent directory", async () => {
    const dirPath = path.join(tmpRoot, "no-such-dir");
    await expect(fs.readDir(dirPath)).rejects.toThrow();
  });

  // ── stat ─────────────────────────────────────────────────────────

  it("should return stat for a file", async () => {
    const filePath = path.join(tmpRoot, "stat-file.txt");
    await fs.writeFile(filePath, "some data");
    const stat = await fs.stat(filePath);
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBeGreaterThan(0);
    expect(stat.mtime).toBeInstanceOf(Date);
  });

  it("should return stat for a directory", async () => {
    const dirPath = path.join(tmpRoot, "stat-dir");
    await fs.mkdir(dirPath);
    const stat = await fs.stat(dirPath);
    expect(stat.isFile).toBe(false);
    expect(stat.isDirectory).toBe(true);
  });

  it("should throw stat for a non-existent path", async () => {
    await expect(fs.stat(path.join(tmpRoot, "ghost"))).rejects.toThrow();
  });

  // ── checksum ─────────────────────────────────────────────────────

  it("should produce deterministic checksums", async () => {
    const filePath = path.join(tmpRoot, "checksum.txt");
    await fs.writeFile(filePath, "deterministic content");
    const sum1 = await fs.checksum(filePath);
    const sum2 = await fs.checksum(filePath);
    expect(sum1).toBe(sum2);
    expect(typeof sum1).toBe("string");
    expect(sum1.length).toBeGreaterThan(0);
  });

  it("should produce different checksums for different content", async () => {
    const file1 = path.join(tmpRoot, "cs1.txt");
    const file2 = path.join(tmpRoot, "cs2.txt");
    await fs.writeFile(file1, "alpha");
    await fs.writeFile(file2, "beta");
    const sum1 = await fs.checksum(file1);
    const sum2 = await fs.checksum(file2);
    expect(sum1).not.toBe(sum2);
  });

  // ── remove ───────────────────────────────────────────────────────

  it("should remove a file", async () => {
    const filePath = path.join(tmpRoot, "to-delete.txt");
    await fs.writeFile(filePath, "bye");
    expect(await fs.exists(filePath)).toBe(true);
    await fs.remove(filePath);
    expect(await fs.exists(filePath)).toBe(false);
  });

  it("should remove a directory", async () => {
    const dirPath = path.join(tmpRoot, "dir-to-delete");
    await fs.mkdir(dirPath);
    await fs.writeFile(path.join(dirPath, "file.txt"), "inside");
    await fs.remove(dirPath);
    expect(await fs.exists(dirPath)).toBe(false);
  });

  // ── chmod ────────────────────────────────────────────────────────

  it("should not throw when changing file mode", async () => {
    const filePath = path.join(tmpRoot, "chmod-test.txt");
    await fs.writeFile(filePath, "permissions");
    // Should not throw (on Windows this may be a no-op, on Unix it sets permissions)
    await expect(fs.chmod(filePath, 0o600)).resolves.toBeUndefined();
  });
});
