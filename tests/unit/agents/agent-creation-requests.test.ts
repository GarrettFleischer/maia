/**
 * @fileoverview Unit tests for the agent creation requests repository.
 * @module tests/unit/agents/agent-creation-requests
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { createAgentCreationRequestsRepository } from "../../../src/agents/agent-creation-requests.js";
import type { AgentCreationRequestStatus } from "../../../src/agents/agent-creation-requests.js";
import { capturingLogger } from "../../helpers/index.js";
import { createSQLiteDatabase } from "../../../src/adapters/database.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function createTestDb(): Promise<ReturnType<typeof createSQLiteDatabase>> {
  const db = createSQLiteDatabase(":memory:");
  const sqlPath = path.resolve(
    "src/core/migrations/migrations/006_add_agent_creation_requests.sql"
  );
  const sql = await fs.readFile(sqlPath, "utf-8");
  await db.execute(sql);
  return db;
}

describe("AgentCreationRequestsRepository", () => {
  let db: ReturnType<typeof createSQLiteDatabase>;

  beforeAll(async () => {
    db = await createTestDb();
  });

  it("create inserts a request with status pending", async () => {
    const repo = createAgentCreationRequestsRepository({
      db,
      logger: capturingLogger(),
    });
    const configJson = JSON.stringify({ id: "new-bot", schedule: "", tools: ["memory_search"] });
    const req = await repo.create({
      id: "req-1",
      requestingAgentId: "agent-a",
      proposedConfigJson: configJson,
    });
    expect(req.id).toBe("req-1");
    expect(req.requestingAgentId).toBe("agent-a");
    expect(req.status).toBe("pending");
    expect(req.proposedConfig.id).toBe("new-bot");
    expect(req.proposedConfig.schedule).toBe("");
    expect(req.resolvedAt).toBeNull();
    expect(req.createdAt).toBeTruthy();
  });

  it("getById returns undefined for missing id", async () => {
    const repo = createAgentCreationRequestsRepository({
      db,
      logger: capturingLogger(),
    });
    const got = await repo.getById("nonexistent");
    expect(got).toBeUndefined();
  });

  it("getById returns the request after create", async () => {
    const repo = createAgentCreationRequestsRepository({
      db,
      logger: capturingLogger(),
    });
    const configJson = JSON.stringify({ id: "get-bot", model: { provider: "ollama", model: "llama3" } });
    await repo.create({
      id: "req-get",
      requestingAgentId: "maia",
      proposedConfigJson: configJson,
    });
    const got = await repo.getById("req-get");
    expect(got).toBeDefined();
    expect(got!.proposedConfig.id).toBe("get-bot");
    expect(got!.proposedConfig.model).toEqual({ provider: "ollama", model: "llama3" });
  });

  it("updateStatus changes status and sets resolvedAt when not pending", async () => {
    const repo = createAgentCreationRequestsRepository({
      db,
      logger: capturingLogger(),
    });
    await repo.create({
      id: "req-update",
      requestingAgentId: "agent-b",
      proposedConfigJson: JSON.stringify({ id: "update-bot" }),
    });
    const updated = await repo.updateStatus("req-update", "approved");
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("approved");
    expect(updated!.resolvedAt).toBeTruthy();
  });

  it("listByStatus returns only requests with that status", async () => {
    const repo = createAgentCreationRequestsRepository({
      db,
      logger: capturingLogger(),
    });
    await repo.create({
      id: "list-p1",
      requestingAgentId: "a1",
      proposedConfigJson: JSON.stringify({ id: "p1" }),
    });
    await repo.create({
      id: "list-p2",
      requestingAgentId: "a2",
      proposedConfigJson: JSON.stringify({ id: "p2" }),
    });
    await repo.updateStatus("list-p2", "approved" as AgentCreationRequestStatus);
    const pending = await repo.listByStatus("pending" as AgentCreationRequestStatus);
    expect(pending.some((r) => r.id === "list-p1")).toBe(true);
    expect(pending.some((r) => r.id === "list-p2")).toBe(false);
    const approved = await repo.listByStatus("approved" as AgentCreationRequestStatus);
    expect(approved.some((r) => r.id === "list-p2")).toBe(true);
  });

  it("updateStatus returns undefined for non-existent id", async () => {
    const repo = createAgentCreationRequestsRepository({
      db,
      logger: capturingLogger(),
    });
    const updated = await repo.updateStatus("no-such-id", "approved");
    expect(updated).toBeUndefined();
  });
});
