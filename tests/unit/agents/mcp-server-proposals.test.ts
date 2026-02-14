/**
 * @fileoverview Unit tests for the MCP server proposals repository.
 * @module tests/unit/agents/mcp-server-proposals
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { createMcpServerProposalsRepository } from "../../../src/agents/mcp-server-proposals.js";
import type { McpServerProposalStatus } from "../../../src/agents/mcp-server-proposals.js";
import { capturingLogger } from "../../helpers/index.js";
import { createSQLiteDatabase } from "../../../src/adapters/database.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * @brief Creates an in-memory DB with mcp_server_proposals table.
 */
async function createTestDb(): Promise<ReturnType<typeof createSQLiteDatabase>> {
  const db = createSQLiteDatabase(":memory:");
  const sqlPath = path.resolve(
    "src/core/migrations/migrations/007_add_mcp_server_proposals.sql"
  );
  const sql = await fs.readFile(sqlPath, "utf-8");
  await db.execute(sql);
  return db;
}

describe("McpServerProposalsRepository", () => {
  let db: ReturnType<typeof createSQLiteDatabase>;

  beforeAll(async () => {
    db = await createTestDb();
  });

  it("create inserts a proposal with status pending_security", async () => {
    const repo = createMcpServerProposalsRepository({
      db,
      logger: capturingLogger(),
    });
    const p = await repo.create({
      id: "prop-1",
      proposingAgentId: "agent-a",
      name: "my-mcp",
      description: "Test MCP server",
      sandboxPath: "/workspace/agent-a/mcp",
    });
    expect(p.id).toBe("prop-1");
    expect(p.proposingAgentId).toBe("agent-a");
    expect(p.name).toBe("my-mcp");
    expect(p.description).toBe("Test MCP server");
    expect(p.sandboxPath).toBe("/workspace/agent-a/mcp");
    expect(p.status).toBe("pending_security");
    expect(p.dockerfilePath).toBeNull();
    expect(p.imageRef).toBeNull();
    expect(p.securityReason).toBeNull();
    expect(p.userFeedback).toBeNull();
    expect(p.createdAt).toBeTruthy();
    expect(p.updatedAt).toBeTruthy();
  });

  it("create accepts optional dockerfilePath and imageRef", async () => {
    const repo = createMcpServerProposalsRepository({
      db,
      logger: capturingLogger(),
    });
    const p = await repo.create({
      id: "prop-2",
      proposingAgentId: "agent-b",
      name: "docker-mcp",
      sandboxPath: "/workspace/agent-b/app",
      dockerfilePath: "Dockerfile.mcp",
      imageRef: "oci:my-registry/mcp:latest",
    });
    expect(p.dockerfilePath).toBe("Dockerfile.mcp");
    expect(p.imageRef).toBe("oci:my-registry/mcp:latest");
  });

  it("getById returns undefined for missing id", async () => {
    const repo = createMcpServerProposalsRepository({
      db,
      logger: capturingLogger(),
    });
    const got = await repo.getById("nonexistent");
    expect(got).toBeUndefined();
  });

  it("getById returns the proposal after create", async () => {
    const repo = createMcpServerProposalsRepository({
      db,
      logger: capturingLogger(),
    });
    const created = await repo.create({
      id: "prop-get",
      proposingAgentId: "agent-x",
      name: "get-test",
      sandboxPath: "/w/x",
    });
    const got = await repo.getById("prop-get");
    expect(got).toBeDefined();
    expect(got!.id).toBe(created.id);
    expect(got!.name).toBe("get-test");
  });

  it("updateStatus changes status and returns updated proposal", async () => {
    const repo = createMcpServerProposalsRepository({
      db,
      logger: capturingLogger(),
    });
    await repo.create({
      id: "prop-update",
      proposingAgentId: "agent-y",
      name: "update-test",
      sandboxPath: "/w/y",
    });
    const updated = await repo.updateStatus("prop-update", "pending_user");
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("pending_user");
    const got = await repo.getById("prop-update");
    expect(got!.status).toBe("pending_user");
  });

  it("updateStatus can set security_reason", async () => {
    const repo = createMcpServerProposalsRepository({
      db,
      logger: capturingLogger(),
    });
    await repo.create({
      id: "prop-deny",
      proposingAgentId: "agent-z",
      name: "deny-test",
      sandboxPath: "/w/z",
    });
    const updated = await repo.updateStatus("prop-deny", "security_denied", {
      securityReason: "Path escapes workspace",
    });
    expect(updated!.securityReason).toBe("Path escapes workspace");
  });

  it("updateStatus can set user_feedback", async () => {
    const repo = createMcpServerProposalsRepository({
      db,
      logger: capturingLogger(),
    });
    await repo.create({
      id: "prop-user-deny",
      proposingAgentId: "agent-u",
      name: "user-deny",
      sandboxPath: "/w/u",
    });
    await repo.updateStatus("prop-user-deny", "pending_user");
    const updated = await repo.updateStatus("prop-user-deny", "user_denied", {
      userFeedback: "Not needed right now",
    });
    expect(updated!.userFeedback).toBe("Not needed right now");
  });

  it("listByStatus returns only proposals with that status", async () => {
    const repo = createMcpServerProposalsRepository({
      db,
      logger: capturingLogger(),
    });
    await repo.create({
      id: "list-pending-1",
      proposingAgentId: "a1",
      name: "n1",
      sandboxPath: "/w/1",
    });
    await repo.create({
      id: "list-pending-2",
      proposingAgentId: "a2",
      name: "n2",
      sandboxPath: "/w/2",
    });
    await repo.updateStatus("list-pending-2", "user_approved");
    const pending = await repo.listByStatus("pending_security" as McpServerProposalStatus);
    expect(pending.some((p) => p.id === "list-pending-1")).toBe(true);
    expect(pending.some((p) => p.id === "list-pending-2")).toBe(false);
    const approved = await repo.listByStatus("user_approved" as McpServerProposalStatus);
    expect(approved.some((p) => p.id === "list-pending-2")).toBe(true);
  });

  it("updateStatus returns undefined for non-existent id", async () => {
    const repo = createMcpServerProposalsRepository({
      db,
      logger: capturingLogger(),
    });
    const updated = await repo.updateStatus("no-such-id", "user_approved");
    expect(updated).toBeUndefined();
  });
});
