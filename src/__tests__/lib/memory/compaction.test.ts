/**
 * @fileoverview Tests for session compaction persistence and expand.
 * @module __tests__/lib/memory/compaction
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "../../helpers/fakes";
import type { AppContext } from "@/lib/context";
import {
  insertSessionCompaction,
  listSessionCompactions,
  expandSessionCompaction,
} from "@/lib/memory/compaction";
import { createSession, appendEntry } from "@/lib/history";

describe("session compaction", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("insert list and expand with missing compaction returns null", () => {
    expect(expandSessionCompaction(ctx, "no-such-id")).toBeNull();
  });

  it("listSessionCompactions parses bad source_entry_ids as empty", () => {
    const sid = createSession(ctx);
    const cid = insertSessionCompaction(ctx, sid, "# Summary", ["a", "b"]);
    ctx.db
      .prepare("UPDATE session_compactions SET source_entry_ids_json = ? WHERE id = ?")
      .run("{", cid);
    const list = listSessionCompactions(ctx, sid);
    expect(list[0].sourceEntryIds).toEqual([]);
  });

  it("expandSessionCompaction loads entries and reports missing ids", () => {
    const sessionId = createSession(ctx);
    const e1 = appendEntry(ctx, sessionId, {
      role: "user",
      content: "hello",
      timestamp: new Date().toISOString(),
    });
    const e2 = appendEntry(ctx, sessionId, {
      role: "agent",
      content: "hi",
      timestamp: new Date().toISOString(),
      toolName: "x",
      toolArgs: { a: 1 },
    });
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const cid = insertSessionCompaction(ctx, sessionId, "Sum", [
      e1.id,
      fakeId,
      e2.id,
    ]);
    const expanded = expandSessionCompaction(ctx, cid);
    expect(expanded).not.toBeNull();
    expect(expanded!.summary).toBe("Sum");
    expect(expanded!.missingIds).toEqual([fakeId]);
    expect(expanded!.entries.length).toBe(2);
    expect(expanded!.entries[0].id).toBe(e1.id);
    expect(expanded!.entries[1].toolArgs).toEqual({ a: 1 });
  });

  it("expandSessionCompaction maps invalid tool_args to undefined", () => {
    const sessionId = createSession(ctx);
    ctx.db
      .prepare(
        `INSERT INTO history_entries (id, session_id, role, content, timestamp, is_compressed, tool_args)
         VALUES (?, ?, 'user', 'c', ?, 0, ?)`,
      )
      .run("x", sessionId, new Date().toISOString(), "not-json");
    const cid = insertSessionCompaction(ctx, sessionId, "md", ["x"]);
    const expanded = expandSessionCompaction(ctx, cid);
    expect(expanded?.entries[0].toolArgs).toBeUndefined();
  });

  it("expandSessionCompaction yields no entries when source_entry_ids_json is invalid", () => {
    const sessionId = createSession(ctx);
    const cid = insertSessionCompaction(ctx, sessionId, "md", []);
    ctx.db
      .prepare("UPDATE session_compactions SET source_entry_ids_json = ? WHERE id = ?")
      .run("{", cid);
    const expanded = expandSessionCompaction(ctx, cid);
    expect(expanded?.entries).toEqual([]);
  });
});
