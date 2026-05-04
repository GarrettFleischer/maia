/**
 * @fileoverview Tests for SQLite memory registry (dedupe, search, prune, touch).
 * @module __tests__/lib/memory/registry
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { v4 as uuidv4 } from "uuid";
import { makeTestContext } from "../../helpers/fakes";
import type { AppContext } from "@/lib/context";
import {
  registryDedupeHash,
  insertRegistryMemory,
  searchRegistryMemories,
  touchRegistryMemories,
  pruneRegistryIfOverCap,
} from "@/lib/memory/registry";

describe("memory registry", () => {
  let ctx: AppContext;
  const agent = "agent-a";
  const emb = [1, 0, 0];

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("registryDedupeHash normalizes case and length", () => {
    const a = registryDedupeHash("  Hello World  ");
    const b = registryDedupeHash("hello world");
    expect(a).toBe(b);
  });

  it("insertRegistryMemory inserts and returns id", () => {
    const id = insertRegistryMemory(ctx, agent, "fact one", emb, "explicit", 0.9);
    expect(typeof id).toBe("string");
    const rows = ctx.db
      .prepare("SELECT content, quality_score FROM memory_registry WHERE id = ?")
      .get(id) as { content: string; quality_score: number };
    expect(rows.content).toBe("fact one");
    expect(rows.quality_score).toBeCloseTo(0.9);
  });

  it("insertRegistryMemory dedupes by hash and bumps access", () => {
    const id1 = insertRegistryMemory(ctx, agent, "Same", emb, "explicit", 1);
    const id2 = insertRegistryMemory(ctx, agent, "  same  ", emb, "explicit", 1);
    expect(id2).toBe(id1);
    const row = ctx.db
      .prepare("SELECT access_count FROM memory_registry WHERE id = ?")
      .get(id1) as { access_count: number };
    expect(row.access_count).toBeGreaterThanOrEqual(1);
  });

  it("searchRegistryMemories ranks by similarity and minQuality", () => {
    insertRegistryMemory(ctx, agent, "alpha", [1, 0, 0], "explicit", 1);
    insertRegistryMemory(ctx, agent, "beta", [0, 1, 0], "explicit", 0.2);
    const q = [1, 0, 0];
    const hits = searchRegistryMemories(ctx, agent, q, 5, 0.15);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].content).toBe("alpha");
  });

  it("searchRegistryMemories treats invalid embedding_json as zero score", () => {
    const id = uuidv4();
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT INTO memory_registry (
           id, agent_id, content, embedding_json, quality_score,
           source_kind, dedupe_hash, created_at, accessed_at, access_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        id,
        agent,
        "bad emb",
        "not-json",
        1,
        "explicit",
        "abcd",
        now,
        now,
      );
    const hits = searchRegistryMemories(ctx, agent, [1, 0, 0], 5, 0);
    const bad = hits.find((h) => h.id === id);
    expect(bad?.score).toBe(0);
  });

  it("touchRegistryMemories updates accessed rows", () => {
    const id = insertRegistryMemory(ctx, agent, "x", emb, "explicit", 1);
    touchRegistryMemories(ctx, [id]);
    const row = ctx.db
      .prepare("SELECT access_count FROM memory_registry WHERE id = ?")
      .get(id) as { access_count: number };
    expect(row.access_count).toBeGreaterThanOrEqual(1);
  });

  it("pruneRegistryIfOverCap removes lowest quality oldest rows", () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      insertRegistryMemory(ctx, agent, `mem-${i}-${uuidv4()}`, [i, 0, 0], "explicit", 0.1 + i * 0.01);
    }
    const deleted = pruneRegistryIfOverCap(ctx, agent, 2);
    expect(deleted).toBe(3);
    const count = (
      ctx.db
        .prepare("SELECT COUNT(1) as c FROM memory_registry WHERE agent_id = ?")
        .get(agent) as { c: number }
    ).c;
    expect(count).toBe(2);
  });

  it("pruneRegistryIfOverCap returns 0 when under cap", () => {
    insertRegistryMemory(ctx, agent, "only", emb, "explicit", 1);
    expect(pruneRegistryIfOverCap(ctx, agent, 10)).toBe(0);
  });
});
