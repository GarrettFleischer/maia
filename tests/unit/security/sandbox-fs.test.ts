/**
 * @fileoverview Unit tests for the sandboxed file system.
 * @module tests/unit/security/sandbox-fs
 */

import path from "node:path";
import { describe, it, expect } from "bun:test";
import { createSandboxedFileSystem } from "../../../src/security/sandbox-fs.js";
import { SecurityError } from "../../../src/core/errors.js";
import { inMemoryFileSystem, mockAuditLog, capturingLogger } from "../../helpers/index.js";

/**
 * @brief Root path that resolves to a consistent absolute path on all platforms.
 */
const SANDBOX_ROOT = path.resolve("/sandbox");

function makeSandbox() {
  const inner = inMemoryFileSystem({
    [path.join(SANDBOX_ROOT, "foo.txt")]: "hello",
    [path.join(SANDBOX_ROOT, "sub", "bar.txt")]: "world",
  });
  const auditLog = mockAuditLog();
  const logger = capturingLogger();
  const fs = createSandboxedFileSystem({
    inner,
    root: SANDBOX_ROOT,
    auditLog,
    logger,
  });
  return { fs, inner, auditLog, logger };
}

describe("SandboxedFileSystem", () => {
  it("should allow readFile under root", async () => {
    const { fs, auditLog } = makeSandbox();
    const p = path.join(SANDBOX_ROOT, "foo.txt");
    const content = await fs.readFile(p);
    expect(content).toBe("hello");
    const denied = auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED");
    expect(denied).toHaveLength(0);
  });

  it("should deny readFile outside root and log", async () => {
    const { fs, auditLog, logger } = makeSandbox();
    const outsidePath = path.resolve("/etc", "passwd");
    await expect(fs.readFile(outsidePath)).rejects.toThrow(SecurityError);
    await expect(fs.readFile(outsidePath)).rejects.toThrow("path outside sandbox");

    const denied = auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED");
    expect(denied).toHaveLength(2);
    expect(denied[0]!.metadata.operation).toBe("readFile");
    expect(denied[0]!.metadata.path).toBe(outsidePath);

    const warnCalls = logger.calls.filter((c) => c.level === "warn");
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("should deny path traversal outside root", async () => {
    const { fs, auditLog } = makeSandbox();
    const traversal = path.join(SANDBOX_ROOT, "..", "etc", "passwd");
    await expect(fs.readFile(traversal)).rejects.toThrow(SecurityError);
    const denied = auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED");
    expect(denied).toHaveLength(1);
  });

  it("should allow writeFile under root", async () => {
    const { fs, auditLog, inner } = makeSandbox();
    const p = path.join(SANDBOX_ROOT, "new.txt");
    await fs.writeFile(p, "data");
    expect(await inner.readFile(p)).toBe("data");
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(0);
  });

  it("should deny writeFile outside root and log", async () => {
    const { fs, auditLog } = makeSandbox();
    const outsidePath = path.resolve("/tmp", "outside.txt");
    await expect(fs.writeFile(outsidePath, "x")).rejects.toThrow(SecurityError);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(1);
    expect(auditLog.entries[0]!.metadata.operation).toBe("writeFile");
  });

  it("should allow exists under root", async () => {
    const { fs, auditLog } = makeSandbox();
    const p = path.join(SANDBOX_ROOT, "foo.txt");
    expect(await fs.exists(p)).toBe(true);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(0);
  });

  it("should deny exists outside root and log", async () => {
    const { fs, auditLog } = makeSandbox();
    const outsidePath = path.resolve("/nonexistent");
    await expect(fs.exists(outsidePath)).rejects.toThrow(SecurityError);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(1);
  });

  it("should allow readDir under root", async () => {
    const { fs, auditLog } = makeSandbox();
    const p = path.join(SANDBOX_ROOT, "sub");
    const names = await fs.readDir(p);
    expect(Array.isArray(names)).toBe(true);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(0);
  });

  it("should deny readDir outside root and log", async () => {
    const { fs, auditLog } = makeSandbox();
    const outsidePath = path.resolve("/usr");
    await expect(fs.readDir(outsidePath)).rejects.toThrow(SecurityError);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(1);
    expect(auditLog.entries[0]!.metadata.operation).toBe("readDir");
  });

  it("should allow mkdir under root", async () => {
    const { fs, auditLog } = makeSandbox();
    const p = path.join(SANDBOX_ROOT, "newdir");
    await fs.mkdir(p);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(0);
  });

  it("should deny mkdir outside root and log", async () => {
    const { fs, auditLog } = makeSandbox();
    const outsidePath = path.resolve("/tmp", "outside");
    await expect(fs.mkdir(outsidePath)).rejects.toThrow(SecurityError);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(1);
  });

  it("should allow remove under root", async () => {
    const { fs, auditLog, inner } = makeSandbox();
    const p = path.join(SANDBOX_ROOT, "foo.txt");
    await fs.remove(p);
    await expect(inner.readFile(p)).rejects.toThrow();
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(0);
  });

  it("should deny remove outside root and log", async () => {
    const { fs, auditLog } = makeSandbox();
    const outsidePath = path.resolve("/etc", "passwd");
    await expect(fs.remove(outsidePath)).rejects.toThrow(SecurityError);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(1);
    expect(auditLog.entries[0]!.metadata.operation).toBe("remove");
  });

  it("should deny appendFile outside root and log", async () => {
    const { fs, auditLog } = makeSandbox();
    const outsidePath = path.resolve("/tmp", "outside.log");
    await expect(fs.appendFile(outsidePath, "data")).rejects.toThrow(SecurityError);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(1);
    expect(auditLog.entries[0]!.metadata.operation).toBe("appendFile");
  });

  it("should deny chmod outside root and log", async () => {
    const { fs, auditLog } = makeSandbox();
    const outsidePath = path.resolve("/etc", "passwd");
    await expect(fs.chmod(outsidePath, 0o644)).rejects.toThrow(SecurityError);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(1);
    expect(auditLog.entries[0]!.metadata.operation).toBe("chmod");
  });

  it("should deny stat outside root and log", async () => {
    const { fs, auditLog } = makeSandbox();
    const outsidePath = path.resolve("/etc", "hosts");
    await expect(fs.stat(outsidePath)).rejects.toThrow(SecurityError);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(1);
    expect(auditLog.entries[0]!.metadata.operation).toBe("stat");
  });

  it("should deny checksum outside root and log", async () => {
    const { fs, auditLog } = makeSandbox();
    const outsidePath = path.resolve("/etc", "shadow");
    await expect(fs.checksum(outsidePath)).rejects.toThrow(SecurityError);
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(1);
    expect(auditLog.entries[0]!.metadata.operation).toBe("checksum");
  });

  it("should allow normalized path under root", async () => {
    const { fs, auditLog, inner } = makeSandbox();
    const withDots = path.join(SANDBOX_ROOT, ".", "a", "..", "b");
    inner.files.set(withDots, "content");
    const content = await fs.readFile(withDots);
    expect(content).toBe("content");
    expect(auditLog.entries.filter((e) => e.type === "FILE_ACCESS_DENIED")).toHaveLength(0);
  });
});
