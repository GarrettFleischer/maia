/**
 * @fileoverview Unit tests for per-context tool access control.
 * @module tests/unit/security/tool-permissions
 */

import { describe, it, expect } from "bun:test";
import { createToolPermissions } from "../../../src/security/tool-permissions.js";
import { mockAuditLog } from "../../helpers/index.js";

describe("Tool Permissions", () => {
  const defaultConfig = {
    main: { allow: ["*"] },
    group: { allow: ["memory_search"], deny: ["web_fetch", "memory_store"] },
    consolidation: { allow: ["memory_store", "memory_search"] },
  };

  it("should allow all tools in main context", () => {
    const perms = createToolPermissions({ config: defaultConfig, auditLog: mockAuditLog() });
    expect(perms.isAllowed("web_fetch", "main")).toBe(true);
    expect(perms.isAllowed("memory_store", "main")).toBe(true);
    expect(perms.isAllowed("memory_search", "main")).toBe(true);
  });

  it("should restrict tools in group context", () => {
    const perms = createToolPermissions({ config: defaultConfig, auditLog: mockAuditLog() });
    expect(perms.isAllowed("memory_search", "group")).toBe(true);
    expect(perms.isAllowed("web_fetch", "group")).toBe(false);
    expect(perms.isAllowed("memory_store", "group")).toBe(false);
  });

  it("should deny always wins over allow", () => {
    const config = {
      special: { allow: ["*"], deny: ["web_fetch"] },
    };
    const perms = createToolPermissions({ config, auditLog: mockAuditLog() });
    expect(perms.isAllowed("web_fetch", "special")).toBe(false);
    expect(perms.isAllowed("memory_search", "special")).toBe(true);
  });

  it("should deny tools not in allow list", () => {
    const config = {
      limited: { allow: ["memory_search"] },
    };
    const perms = createToolPermissions({ config, auditLog: mockAuditLog() });
    expect(perms.isAllowed("memory_search", "limited")).toBe(true);
    expect(perms.isAllowed("web_fetch", "limited")).toBe(false);
  });

  it("should deny all tools for unknown contexts", () => {
    const perms = createToolPermissions({ config: defaultConfig, auditLog: mockAuditLog() });
    expect(perms.isAllowed("memory_search", "unknown")).toBe(false);
  });

  it("should log tool permission checks to audit log", () => {
    const auditLog = mockAuditLog();
    const perms = createToolPermissions({ config: defaultConfig, auditLog });
    perms.isAllowed("web_fetch", "group");

    const events = auditLog.entries.filter((e) => e.type === "TOOL_CALL");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});
