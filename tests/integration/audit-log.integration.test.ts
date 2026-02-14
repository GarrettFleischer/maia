/**
 * @fileoverview Integration test for AuditLog with real filesystem + real clock.
 * @module tests/integration/audit-log
 *
 * @note Uses a real temp directory and real clock to prove that
 * append-to-file audit logging works on actual disk.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsNative from "node:fs/promises";
import { createAuditLog } from "../../src/security/audit-log.js";
import { createRealFileSystem } from "../../src/adapters/filesystem.js";
import { createRealClock } from "../../src/adapters/clock.js";

describe("AuditLog with real filesystem (integration)", () => {
  const tmpDir = path.join(os.tmpdir(), `maia-audit-test-${Date.now()}`);
  const realFs = createRealFileSystem();
  const realClock = createRealClock();

  beforeAll(async () => {
    await fsNative.mkdir(tmpDir, { recursive: true });
  });

  afterAll(async () => {
    await fsNative.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * @brief Creates a fresh audit log pointing to a unique file.
   */
  function createTestLog(name: string) {
    const logPath = path.join(tmpDir, `${name}.jsonl`);
    return { log: createAuditLog({ fs: realFs, clock: realClock, logPath }), logPath };
  }

  // ── Basic write + read ───────────────────────────────────────────

  it("should write an audit event and read it back", async () => {
    const { log } = createTestLog("basic");

    await log.log("AUTH_SUCCESS", { ip: "127.0.0.1" });

    const entries = await log.read();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("AUTH_SUCCESS");
    expect(entries[0].metadata.ip).toBe("127.0.0.1");
    expect(entries[0].timestamp).toBeTruthy();
  });

  // ── File actually exists on disk ─────────────────────────────────

  it("should create the log file on disk", async () => {
    const { log, logPath } = createTestLog("ondisk");
    await log.log("TOOL_CALL", { tool: "web_fetch" });

    const exists = await realFs.exists(logPath);
    expect(exists).toBe(true);

    // Raw file should contain JSON lines
    const raw = await realFs.readFile(logPath);
    const lines = raw.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("TOOL_CALL");
  });

  // ── Multiple entries append correctly ────────────────────────────

  it("should append multiple entries", async () => {
    const { log } = createTestLog("multi");

    await log.log("AUTH_SUCCESS", { user: "alice" });
    await log.log("RATE_LIMIT", { ip: "10.0.0.1" });
    await log.log("AUTH_FAILURE", { ip: "10.0.0.2" });

    const entries = await log.read();
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("AUTH_SUCCESS");
    expect(entries[1].type).toBe("RATE_LIMIT");
    expect(entries[2].type).toBe("AUTH_FAILURE");
  });

  // ── Filter by type ───────────────────────────────────────────────

  it("should filter by event type", async () => {
    const { log } = createTestLog("filter-type");

    await log.log("AUTH_SUCCESS", {});
    await log.log("AUTH_FAILURE", {});
    await log.log("AUTH_SUCCESS", {});

    const failures = await log.read({ type: "AUTH_FAILURE" });
    expect(failures).toHaveLength(1);
    expect(failures[0].type).toBe("AUTH_FAILURE");
  });

  // ── Filter by limit ──────────────────────────────────────────────

  it("should respect limit (returns last N entries)", async () => {
    const { log } = createTestLog("filter-limit");

    await log.log("TOOL_CALL", { tool: "first" });
    await log.log("TOOL_CALL", { tool: "second" });
    await log.log("TOOL_CALL", { tool: "third" });

    const limited = await log.read({ limit: 2 });
    expect(limited).toHaveLength(2);
    // Should be the last 2 entries
    expect(limited[0].metadata.tool).toBe("second");
    expect(limited[1].metadata.tool).toBe("third");
  });

  // ── read() when log file does not exist yet ──────────────────────

  it("should return empty array when log file does not exist yet", async () => {
    const { log } = createTestLog("no-file-yet");
    const entries = await log.read();
    expect(entries).toEqual([]);
  });

  // ── Filter by since date ─────────────────────────────────────────

  it("should filter by since date", async () => {
    const { log } = createTestLog("since");

    await log.log("EVENT_A", { n: 1 });
    const afterFirst = new Date();
    await log.log("EVENT_B", { n: 2 });
    await log.log("EVENT_C", { n: 3 });

    const entriesSince = await log.read({ since: afterFirst });
    expect(entriesSince.length).toBeGreaterThanOrEqual(2);
    expect(entriesSince.some((e) => e.metadata.n === 2)).toBe(true);
    expect(entriesSince.some((e) => e.metadata.n === 3)).toBe(true);
  });

  // ── Create parent directories if needed ──────────────────────────

  it("should create parent directories for the log path", async () => {
    const logPath = path.join(tmpDir, "nested", "deep", "audit.jsonl");
    const log = createAuditLog({ fs: realFs, clock: realClock, logPath });

    await log.log("HEALTH_CHECK", { status: "ok" });
    const entries = await log.read();
    expect(entries).toHaveLength(1);
  });
});
