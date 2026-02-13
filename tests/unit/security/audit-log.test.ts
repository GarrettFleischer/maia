/**
 * @fileoverview Unit tests for the append-only security audit log.
 * @module tests/unit/security/audit-log
 */

import { describe, it, expect } from "bun:test";
import { createAuditLog } from "../../../src/security/audit-log.js";
import { inMemoryFileSystem, fixedClock } from "../../helpers/index.js";

describe("Audit Log", () => {
  function makeLog() {
    const fs = inMemoryFileSystem();
    const clock = fixedClock();
    const log = createAuditLog({ fs, clock, logPath: "/data/audit.log" });
    return { log, fs, clock };
  }

  it("should append entries to the log file", async () => {
    const { log, fs } = makeLog();
    await log.log("AUTH_SUCCESS", { ip: "192.168.1.1" });

    const content = await fs.readFile("/data/audit.log");
    expect(content).toContain("AUTH_SUCCESS");
    expect(content).toContain("192.168.1.1");
  });

  it("should include timestamp in entries", async () => {
    const { log, fs } = makeLog();
    await log.log("AUTH_FAILURE", { ip: "10.0.0.1" });

    const content = await fs.readFile("/data/audit.log");
    expect(content).toContain("2026-02-13");
  });

  it("should append multiple entries", async () => {
    const { log, fs } = makeLog();
    await log.log("AUTH_SUCCESS", { ip: "1.1.1.1" });
    await log.log("AUTH_FAILURE", { ip: "2.2.2.2" });
    await log.log("RATE_LIMIT", { ip: "3.3.3.3" });

    const content = await fs.readFile("/data/audit.log");
    expect(content).toContain("AUTH_SUCCESS");
    expect(content).toContain("AUTH_FAILURE");
    expect(content).toContain("RATE_LIMIT");
  });

  it("should read entries filtered by type", async () => {
    const { log } = makeLog();
    await log.log("AUTH_SUCCESS", { ip: "1.1.1.1" });
    await log.log("AUTH_FAILURE", { ip: "2.2.2.2" });
    await log.log("AUTH_SUCCESS", { ip: "3.3.3.3" });

    const entries = await log.read({ type: "AUTH_FAILURE" });
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata.ip).toBe("2.2.2.2");
  });

  it("should read entries with limit", async () => {
    const { log } = makeLog();
    for (let i = 0; i < 10; i++) {
      await log.log("AUTH_SUCCESS", { ip: `10.0.0.${i}` });
    }

    const entries = await log.read({ limit: 3 });
    expect(entries).toHaveLength(3);
  });

  it("should never contain sensitive content -- only metadata", async () => {
    const { log, fs } = makeLog();
    await log.log("CREDENTIAL_ACCESS", {
      name: "github-token",
      tool: "web_fetch",
    });

    const content = await fs.readFile("/data/audit.log");
    expect(content).toContain("github-token");
    expect(content).toContain("web_fetch");
    // Should not contain any actual credential values
    expect(content).not.toContain("ghp_");
  });

  it("should handle concurrent writes", async () => {
    const { log } = makeLog();
    await Promise.all([
      log.log("AUTH_SUCCESS", { ip: "1.1.1.1" }),
      log.log("AUTH_FAILURE", { ip: "2.2.2.2" }),
      log.log("RATE_LIMIT", { ip: "3.3.3.3" }),
    ]);

    const entries = await log.read();
    expect(entries).toHaveLength(3);
  });
});
