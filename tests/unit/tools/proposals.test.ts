/**
 * @fileoverview Unit tests for the tool proposals repository.
 * @module tests/unit/tools/proposals
 */

import { describe, it, expect } from "bun:test";
import { createToolProposalsRepository } from "../../../src/tools/proposals.js";
import type { Database } from "../../../src/core/types.js";
import { capturingLogger } from "../../helpers/index.js";

/**
 * In-memory DB that supports tool_proposals and key_value for repository tests.
 */
function mockProposalsDatabase(): Database {
  const toolProposals: Record<string, unknown>[] = [];
  const keyValue = new Map<string, string>();

  return {
    async execute(sql: string, params?: unknown[]): Promise<void> {
      const p = params ?? [];
      if (sql.includes("INSERT INTO tool_proposals")) {
        toolProposals.push({
          id: p[0],
          proposing_agent_id: p[1],
          name: p[2],
          description: p[3],
          parameters_json: p[4],
          implementation_type: p[5],
          implementation_config_json: p[6],
          status: "pending_security",
          security_reason: null,
          user_feedback: null,
          created_at: p[7],
          updated_at: p[8],
        });
      } else if (sql.includes("UPDATE tool_proposals")) {
        const id = p[p.length - 1] as string;
        const row = toolProposals.find((r) => r.id === id);
        if (row) {
          const r = row as Record<string, unknown>;
          r.status = p[0];
          if (p.length === 3) r.updated_at = p[1];
          else if (p.length === 4) {
            r.updated_at = p[2];
            if (sql.includes("security_reason")) r.security_reason = p[1];
            if (sql.includes("user_feedback")) r.user_feedback = p[1];
          } else {
            r.security_reason = p[1];
            r.user_feedback = p[2];
            r.updated_at = p[3];
          }
        }
      } else if (sql.includes("key_value")) {
        keyValue.set("last_checkin_security_at", p[0] as string);
      }
    },
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const p = params ?? [];
      if (sql.includes("SELECT * FROM tool_proposals WHERE id")) {
        const id = p[0] as string;
        const row = toolProposals.find((r) => r.id === id);
        return row ? ([row] as T[]) : [];
      }
      if (sql.includes("SELECT * FROM tool_proposals WHERE status")) {
        const status = p[0] as string;
        const rows = toolProposals.filter((r) => r.status === status);
        return [...rows].sort(
          (a, b) =>
            String((a as { created_at: string }).created_at).localeCompare(
              String((b as { created_at: string }).created_at)
            )
        ) as T[];
      }
      if (sql.includes("SELECT value FROM key_value")) {
        const val = keyValue.get("last_checkin_security_at");
        return (val !== undefined ? [{ value: val }] : []) as T[];
      }
      return [];
    },
    async close(): Promise<void> {},
  };
}

describe("ToolProposalsRepository", () => {
  it("should create a proposal and return it", async () => {
    const db = mockProposalsDatabase();
    const repo = createToolProposalsRepository({ db, logger: capturingLogger() });
    const created = await repo.create({
      id: "prop-1",
      proposingAgentId: "maia",
      name: "my_tool",
      description: "A useful tool that does something safe.",
      parametersJson: '{"type":"object","properties":{}}',
      implementationType: "inline",
    });
    expect(created.id).toBe("prop-1");
    expect(created.name).toBe("my_tool");
    expect(created.status).toBe("pending_security");
    expect(created.proposingAgentId).toBe("maia");

    const got = await repo.getById("prop-1");
    expect(got).toBeDefined();
    expect(got!.name).toBe("my_tool");
  });

  it("should return undefined for unknown id", async () => {
    const db = mockProposalsDatabase();
    const repo = createToolProposalsRepository({ db, logger: capturingLogger() });
    const got = await repo.getById("nonexistent");
    expect(got).toBeUndefined();
  });

  it("should update status only", async () => {
    const db = mockProposalsDatabase();
    const repo = createToolProposalsRepository({ db, logger: capturingLogger() });
    await repo.create({
      id: "p2",
      proposingAgentId: "bot",
      name: "other_tool",
      description: "Another tool with a good description here.",
      parametersJson: "{}",
      implementationType: "inline",
    });
    const updated = await repo.updateStatus("p2", "security_denied");
    expect(updated?.status).toBe("security_denied");

    const got = await repo.getById("p2");
    expect(got?.status).toBe("security_denied");
  });

  it("should update status with security reason", async () => {
    const db = mockProposalsDatabase();
    const repo = createToolProposalsRepository({ db, logger: capturingLogger() });
    await repo.create({
      id: "p3",
      proposingAgentId: "maia",
      name: "safe_tool",
      description: "A safe tool with enough description text.",
      parametersJson: "{}",
      implementationType: "inline",
    });
    const updated = await repo.updateStatus("p3", "security_denied", {
      securityReason: "SSRF risk",
    });
    expect(updated?.status).toBe("security_denied");
    expect(updated?.securityReason).toBe("SSRF risk");
  });

  it("should update status with user feedback", async () => {
    const db = mockProposalsDatabase();
    const repo = createToolProposalsRepository({ db, logger: capturingLogger() });
    await repo.create({
      id: "p4",
      proposingAgentId: "maia",
      name: "user_tool",
      description: "A tool that the user will reject or modify.",
      parametersJson: "{}",
      implementationType: "inline",
    });
    const updated = await repo.updateStatus("p4", "user_denied", {
      userFeedback: "Not needed",
    });
    expect(updated?.status).toBe("user_denied");
    expect(updated?.userFeedback).toBe("Not needed");
  });

  it("should list by status", async () => {
    const db = mockProposalsDatabase();
    const repo = createToolProposalsRepository({ db, logger: capturingLogger() });
    await repo.create({
      id: "a",
      proposingAgentId: "maia",
      name: "first",
      description: "First tool with a long enough description.",
      parametersJson: "{}",
      implementationType: "inline",
    });
    await repo.updateStatus("a", "pending_user");
    await repo.create({
      id: "b",
      proposingAgentId: "maia",
      name: "second",
      description: "Second tool with a long enough description.",
      parametersJson: "{}",
      implementationType: "inline",
    });
    const pending = await repo.listByStatus("pending_security");
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe("second");
    const pendingUser = await repo.listByStatus("pending_user");
    expect(pendingUser).toHaveLength(1);
    expect(pendingUser[0].name).toBe("first");
  });

  it("should get and set last check-in security timestamp", async () => {
    const db = mockProposalsDatabase();
    const repo = createToolProposalsRepository({ db, logger: capturingLogger() });
    const initial = await repo.getLastCheckinSecurityAt();
    expect(initial).toBeNull();

    await repo.setLastCheckinSecurityAt("2026-02-13T14:00:00.000Z");
    const after = await repo.getLastCheckinSecurityAt();
    expect(after).toBe("2026-02-13T14:00:00.000Z");

    await repo.setLastCheckinSecurityAt("2026-02-13T15:00:00.000Z");
    const updated = await repo.getLastCheckinSecurityAt();
    expect(updated).toBe("2026-02-13T15:00:00.000Z");
  });
});
