/**
 * @fileoverview Unit tests for Tier 1 daily log management (append-only, immutable).
 * @module tests/unit/memory/daily-log
 */

import { describe, it, expect } from "bun:test";
import { createDailyLog } from "../../../src/memory/daily-log.js";
import { inMemoryFileSystem, fixedClock, mockAuditLog } from "../../helpers/index.js";

describe("Daily Log", () => {
  function makeLog() {
    const fs = inMemoryFileSystem();
    const clock = fixedClock(new Date("2026-02-13T14:30:00.000Z"));
    const auditLog = mockAuditLog();
    const log = createDailyLog({
      fs,
      clock,
      auditLog,
      basePath: "/workspace/memory",
    });
    return { log, fs, clock };
  }

  it("should append to today's log file", async () => {
    const { log, fs } = makeLog();
    await log.append("User asked about TypeScript patterns.");

    const content = await fs.readFile("/workspace/memory/2026-02-13.md");
    expect(content).toContain("TypeScript patterns");
  });

  it("should create the file if it does not exist", async () => {
    const { log, fs } = makeLog();
    await log.append("First entry of the day.");

    expect(await fs.exists("/workspace/memory/2026-02-13.md")).toBe(true);
  });

  it("should append multiple entries to the same file", async () => {
    const { log, fs } = makeLog();
    await log.append("Entry 1");
    await log.append("Entry 2");
    await log.append("Entry 3");

    const content = await fs.readFile("/workspace/memory/2026-02-13.md");
    expect(content).toContain("Entry 1");
    expect(content).toContain("Entry 2");
    expect(content).toContain("Entry 3");
  });

  it("should read today's log", async () => {
    const { log, fs } = makeLog();
    await fs.writeFile("/workspace/memory/2026-02-13.md", "# 2026-02-13\nSome notes.");

    const content = await log.readToday();
    expect(content).toContain("Some notes");
  });

  it("should return empty for today if no log exists", async () => {
    const { log } = makeLog();
    const content = await log.readToday();
    expect(content).toBe("");
  });

  it("should read yesterday's log", async () => {
    const { log, fs } = makeLog();
    await fs.writeFile("/workspace/memory/2026-02-12.md", "# 2026-02-12\nYesterday's notes.");

    const content = await log.readYesterday();
    expect(content).toContain("Yesterday's notes");
  });

  it("should read a specific date's log", async () => {
    const { log, fs } = makeLog();
    await fs.writeFile("/workspace/memory/2026-02-01.md", "# 2026-02-01\nOld notes.");

    const content = await log.readDate("2026-02-01");
    expect(content).toContain("Old notes");
  });

  it("should never modify existing content (append-only)", async () => {
    const { log, fs } = makeLog();
    await fs.writeFile("/workspace/memory/2026-02-13.md", "Original content.\n");

    await log.append("New entry.");

    const content = await fs.readFile("/workspace/memory/2026-02-13.md");
    expect(content).toContain("Original content.");
    expect(content).toContain("New entry.");
  });

  it("should include timestamp in appended entries", async () => {
    const { log, fs } = makeLog();
    await log.append("Timestamped entry.");

    const content = await fs.readFile("/workspace/memory/2026-02-13.md");
    expect(content).toMatch(/\d{2}:\d{2}/); // Contains time
  });
});
