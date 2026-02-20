/**
 * @fileoverview Integration tests for per-agent memory store (insert, search, delete).
 * @module tests/db/memory.test
 */

import { describe, expect, it } from "bun:test";
import { openDb } from "@/db/client";
import { createMemoryRepository } from "@/db/memory";

describe("memory repository", () => {
  it("insert and search scoped by agent_id", async () => {
    const db = await openDb(":memory:");
    const repo = createMemoryRepository(db);
    const id1 = await repo.insert("agent-1", "User likes pizza");
    const id2 = await repo.insert("agent-2", "User prefers tea");
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    const results1 = await repo.search("agent-1", "pizza");
    const results2 = await repo.search("agent-2", "tea");
    expect(results1.length).toBe(1);
    expect(results1[0].content).toContain("pizza");
    expect(results2.length).toBe(1);
    expect(results2[0].content).toContain("tea");
    expect((await repo.search("agent-1", "tea")).length).toBe(0);
    db.close();
  });

  it("delete removes only specified chunk for agent", async () => {
    const db = await openDb(":memory:");
    const repo = createMemoryRepository(db);
    const id = await repo.insert("agent-1", "Secret note");
    await repo.delete("agent-1", id);
    expect((await repo.search("agent-1", "Secret")).length).toBe(0);
    db.close();
  });
});
