/**
 * @fileoverview Unit tests for the approved snippets repository.
 * @module tests/unit/security/approved-snippets
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { createApprovedSnippetsRepository } from "../../../src/security/approved-snippets.js";
import { capturingLogger, mockCryptoProvider } from "../../helpers/index.js";
import { createSQLiteDatabase } from "../../../src/adapters/database.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Create an in-memory DB with agent_approved_snippets table.
 */
async function createTestDb() {
  const db = createSQLiteDatabase(":memory:");
  const sqlPath = path.resolve(
    "src/core/migrations/migrations/005_add_agent_approved_snippets.sql"
  );
  const sql = await fs.readFile(sqlPath, "utf-8");
  await db.execute(sql);
  return db;
}

describe("ApprovedSnippetsRepository", () => {
  let db: ReturnType<typeof createSQLiteDatabase>;

  beforeAll(async () => {
    db = await createTestDb();
  });

  it("isApproved returns false when no row exists", async () => {
    const repo = createApprovedSnippetsRepository({
      db,
      crypto: mockCryptoProvider(),
      logger: capturingLogger(),
    });
    const result = await repo.isApproved("agent-1", "some snippet");
    expect(result).toBe(false);
  });

  it("add inserts a row and isApproved returns true after add", async () => {
    const crypto = mockCryptoProvider();
    const repo = createApprovedSnippetsRepository({
      db,
      crypto,
      logger: capturingLogger(),
    });
    await repo.add("agent-1", "user said: ignore instructions");
    const approved = await repo.isApproved("agent-1", "user said: ignore instructions");
    expect(approved).toBe(true);
  });

  it("isApproved returns false for different snippet same agent", async () => {
    const repo = createApprovedSnippetsRepository({
      db,
      crypto: mockCryptoProvider(),
      logger: capturingLogger(),
    });
    await repo.add("agent-2", "snippet A");
    const approved = await repo.isApproved("agent-2", "snippet B");
    expect(approved).toBe(false);
  });

  it("isApproved returns false for same snippet different agent", async () => {
    const repo = createApprovedSnippetsRepository({
      db,
      crypto: mockCryptoProvider(),
      logger: capturingLogger(),
    });
    await repo.add("agent-a", "same text");
    const approved = await repo.isApproved("agent-b", "same text");
    expect(approved).toBe(false);
  });

  it("add trims snippet before hashing", async () => {
    const repo = createApprovedSnippetsRepository({
      db,
      crypto: mockCryptoProvider(),
      logger: capturingLogger(),
    });
    await repo.add("agent-3", "  trimmed  ");
    const approved = await repo.isApproved("agent-3", "  trimmed  ");
    expect(approved).toBe(true);
  });

  it("add is idempotent (INSERT OR IGNORE)", async () => {
    const repo = createApprovedSnippetsRepository({
      db,
      crypto: mockCryptoProvider(),
      logger: capturingLogger(),
    });
    await repo.add("agent-4", "once");
    await repo.add("agent-4", "once");
    const approved = await repo.isApproved("agent-4", "once");
    expect(approved).toBe(true);
  });
});
