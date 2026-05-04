/**
 * @fileoverview Tests for episodic memory graph (episodes, entities, edges, search).
 * @module __tests__/lib/memory/graph
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { v4 as uuidv4 } from "uuid";
import { makeTestContext } from "../../helpers/fakes";
import type { AppContext } from "@/lib/context";
import {
  insertMemoryEpisode,
  searchMemoryEpisodes,
  insertMemoryEntity,
  insertMemoryEdge,
  expandGraphNeighbors,
} from "@/lib/memory/graph";

describe("memory graph", () => {
  let ctx: AppContext;
  const agent = "ag-g";
  const sess = "sess-1";
  const emb = [0, 0, 1];

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("insertMemoryEpisode and searchMemoryEpisodes", () => {
    const eid = insertMemoryEpisode(ctx, agent, sess, ["e1", "e2"], "deployed", emb);
    const hits = searchMemoryEpisodes(ctx, agent, emb, 5);
    expect(hits.some((h) => h.id === eid && h.entryIds.length === 2)).toBe(true);
  });

  it("searchMemoryEpisodes handles bad embedding_json", () => {
    const id = uuidv4();
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT INTO memory_episodes (
           id, agent_id, session_id, entry_ids_json, summary, embedding_json, created_at, accessed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, agent, sess, "[]", "broken", "oops", now, now);
    const hits = searchMemoryEpisodes(ctx, agent, emb, 10);
    const row = hits.find((h) => h.id === id);
    expect(row?.score).toBe(0);
    expect(row?.entryIds).toEqual([]);
  });

  it("searchMemoryEpisodes handles invalid entry_ids_json", () => {
    const id = insertMemoryEpisode(ctx, agent, sess, [], "ok", emb);
    ctx.db
      .prepare("UPDATE memory_episodes SET entry_ids_json = ? WHERE id = ?")
      .run("not-array", id);
    const hits = searchMemoryEpisodes(ctx, agent, emb, 10);
    const row = hits.find((h) => h.id === id);
    expect(row?.entryIds).toEqual([]);
  });

  it("insertMemoryEntity insertMemoryEdge expandGraphNeighbors", () => {
    const a = insertMemoryEntity(ctx, agent, "Project A", "project", { key: "v" });
    const b = insertMemoryEntity(ctx, agent, "Task B", "task", {});
    const edgeId = insertMemoryEdge(ctx, agent, a, b, "contains");
    expect(edgeId.length).toBeGreaterThan(0);
    const na = expandGraphNeighbors(ctx, agent, a);
    const nb = expandGraphNeighbors(ctx, agent, b);
    expect(na).toContain(b);
    expect(nb).toContain(a);
  });
});
