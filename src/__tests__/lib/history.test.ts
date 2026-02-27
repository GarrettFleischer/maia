import { describe, it, expect, beforeEach } from "bun:test";
import { makeTestContext } from "../helpers/fakes";
import {
  createSession,
  listSessions,
  getSession,
  appendEntry,
  updateSessionMeta,
  deleteSession,
  getActiveSessionId,
  setActiveSessionId,
  searchEntries,
  searchAcrossSessions,
  truncateHistoryAfterIndex,
} from "@/lib/history";
import type { AppContext } from "@/lib/context";

describe("history", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  // ─── createSession ──────────────────────────────────────────────────────────

  describe("createSession", () => {
    it("returns a UUID string", () => {
      const id = createSession(ctx);
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("creates a session with default participants", () => {
      const id = createSession(ctx);
      const session = getSession(ctx, id);
      expect(session?.participants).toEqual(["user", "maia"]);
    });

    it("creates a session with custom participants", () => {
      const id = createSession(ctx, ["agent-a", "agent-b"], "agents");
      const session = getSession(ctx, id);
      expect(session?.participants).toEqual(["agent-a", "agent-b"]);
    });

    it("creates a user-type session by default", () => {
      const id = createSession(ctx);
      const sessions = listSessions(ctx, "user");
      expect(sessions.some((s) => s.id === id)).toBe(true);
    });

    it("creates an agents-type session when specified", () => {
      const id = createSession(ctx, ["a", "b"], "agents");
      const sessions = listSessions(ctx, "agents");
      expect(sessions.some((s) => s.id === id)).toBe(true);
    });

    it("starts with empty tags and empty name/description", () => {
      const id = createSession(ctx);
      const session = getSession(ctx, id);
      expect(session?.tags).toEqual([]);
      expect(session?.name).toBe("");
      expect(session?.description).toBe("");
    });

    it("creates a session with optional name when provided", () => {
      const id = createSession(ctx, ["user", "maia"], "user", "My thread");
      const session = getSession(ctx, id);
      expect(session?.name).toBe("My thread");
    });
  });

  // ─── listSessions ───────────────────────────────────────────────────────────

  describe("listSessions", () => {
    it("returns all sessions when type is 'all'", () => {
      createSession(ctx, ["user", "maia"], "user");
      createSession(ctx, ["a", "b"], "agents");
      const all = listSessions(ctx, "all");
      expect(all.length).toBe(2);
    });

    it("filters to only user sessions", () => {
      createSession(ctx, ["user", "maia"], "user");
      createSession(ctx, ["a", "b"], "agents");
      expect(listSessions(ctx, "user").length).toBe(1);
    });

    it("filters to only agent sessions", () => {
      createSession(ctx, ["user", "maia"], "user");
      createSession(ctx, ["a", "b"], "agents");
      expect(listSessions(ctx, "agents").length).toBe(1);
    });

    it("returns sessions sorted by updated_at descending", async () => {
      const id1 = createSession(ctx);
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));
      const id2 = createSession(ctx);
      const sessions = listSessions(ctx);
      expect(sessions[0].id).toBe(id2);
      expect(sessions[1].id).toBe(id1);
    });

    it("returns session meta including type", () => {
      const userId = createSession(ctx, ["user", "maia"], "user");
      const agentsId = createSession(ctx, ["a", "b"], "agents");
      const all = listSessions(ctx, "all");
      const userSession = all.find((s) => s.id === userId);
      const agentsSession = all.find((s) => s.id === agentsId);
      expect(userSession?.type).toBe("user");
      expect(agentsSession?.type).toBe("agents");
    });
  });

  // ─── getSession ─────────────────────────────────────────────────────────────

  describe("getSession", () => {
    it("returns null for a non-existent session", () => {
      expect(getSession(ctx, "no-such-id")).toBeNull();
    });

    it("returns a session with empty original and compressed arrays", () => {
      const id = createSession(ctx);
      const session = getSession(ctx, id);
      expect(session?.original).toEqual([]);
      expect(session?.compressed).toEqual([]);
    });

    it("returns session including type", () => {
      const userId = createSession(ctx, ["user", "maia"], "user");
      const agentsId = createSession(ctx, ["a", "b"], "agents");
      expect(getSession(ctx, userId)?.type).toBe("user");
      expect(getSession(ctx, agentsId)?.type).toBe("agents");
    });

    it("includes original entries in the original array", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, { role: "user", content: "hello", timestamp: new Date().toISOString() });
      const session = getSession(ctx, id);
      expect(session?.original.length).toBe(1);
      expect(session?.original[0].content).toBe("hello");
    });

    it("separates compressed from original entries", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, { role: "user", content: "original", timestamp: new Date().toISOString() }, false);
      appendEntry(ctx, id, { role: "user", content: "compressed", timestamp: new Date().toISOString() }, true);
      const session = getSession(ctx, id);
      expect(session?.original.length).toBe(1);
      expect(session?.compressed.length).toBe(1);
    });
  });

  // ─── appendEntry ────────────────────────────────────────────────────────────

  describe("appendEntry", () => {
    it("returns the entry with a generated id", () => {
      const id = createSession(ctx);
      const entry = appendEntry(ctx, id, { role: "user", content: "hi", timestamp: new Date().toISOString() });
      expect(typeof entry.id).toBe("string");
      expect(entry.content).toBe("hi");
    });

    it("bumps session updated_at", async () => {
      const id = createSession(ctx);
      const before = getSession(ctx, id)!.updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      appendEntry(ctx, id, { role: "user", content: "bump", timestamp: new Date().toISOString() });
      const after = getSession(ctx, id)!.updatedAt;
      expect(after > before).toBe(true);
    });

    it("stores toolName and toolArgs when provided", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, {
        role: "tool_call",
        content: "{}",
        toolName: "file_read",
        toolArgs: { path: "foo.txt" },
        timestamp: new Date().toISOString(),
      });
      const session = getSession(ctx, id);
      expect(session?.original[0].toolName).toBe("file_read");
      expect(session?.original[0].toolArgs).toEqual({ path: "foo.txt" });
    });
  });

  // ─── updateSessionMeta ──────────────────────────────────────────────────────

  describe("updateSessionMeta", () => {
    it("updates the name", () => {
      const id = createSession(ctx);
      updateSessionMeta(ctx, id, { name: "My Session" });
      expect(getSession(ctx, id)?.name).toBe("My Session");
    });

    it("updates the description", () => {
      const id = createSession(ctx);
      updateSessionMeta(ctx, id, { description: "A test session" });
      expect(getSession(ctx, id)?.description).toBe("A test session");
    });

    it("updates tags", () => {
      const id = createSession(ctx);
      updateSessionMeta(ctx, id, { tags: ["typescript", "testing"] });
      expect(getSession(ctx, id)?.tags).toEqual(["typescript", "testing"]);
    });

    it("only touches fields that are passed", () => {
      const id = createSession(ctx);
      updateSessionMeta(ctx, id, { name: "Named" });
      updateSessionMeta(ctx, id, { description: "Described" });
      const session = getSession(ctx, id);
      expect(session?.name).toBe("Named");
      expect(session?.description).toBe("Described");
    });
  });

  // ─── deleteSession ──────────────────────────────────────────────────────────

  describe("deleteSession", () => {
    it("removes session from list and getSession returns null", () => {
      const id = createSession(ctx);
      expect(listSessions(ctx, "all").some((s) => s.id === id)).toBe(true);
      const deleted = deleteSession(ctx, id);
      expect(deleted).toBe(true);
      expect(listSessions(ctx, "all").some((s) => s.id === id)).toBe(false);
      expect(getSession(ctx, id)).toBeNull();
    });

    it("clears active_session when deleted session was active", () => {
      const id = createSession(ctx);
      setActiveSessionId(ctx, id);
      expect(getActiveSessionId(ctx)).toBe(id);
      deleteSession(ctx, id);
      expect(getActiveSessionId(ctx)).toBeNull();
    });

    it("leaves other sessions and active session unchanged when deleting non-active", () => {
      const id1 = createSession(ctx);
      const id2 = createSession(ctx);
      setActiveSessionId(ctx, id2);
      deleteSession(ctx, id1);
      expect(getSession(ctx, id1)).toBeNull();
      expect(getSession(ctx, id2)).not.toBeNull();
      expect(getActiveSessionId(ctx)).toBe(id2);
    });

    it("returns false for non-existent session id", () => {
      const deleted = deleteSession(ctx, "no-such-id");
      expect(deleted).toBe(false);
    });
  });

  // ─── active session ─────────────────────────────────────────────────────────

  describe("active session", () => {
    it("returns null when no active session is set", () => {
      expect(getActiveSessionId(ctx)).toBeNull();
    });

    it("sets and gets the active session id", () => {
      const id = createSession(ctx);
      setActiveSessionId(ctx, id);
      expect(getActiveSessionId(ctx)).toBe(id);
    });
  });

  // ─── searchEntries ──────────────────────────────────────────────────────────

  describe("searchEntries", () => {
    it("returns empty array for empty query", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, { role: "user", content: "hello world", timestamp: new Date().toISOString() });
      expect(searchEntries(ctx, "", id)).toEqual([]);
    });

    it("finds entries matching the query", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, { role: "user", content: "TypeScript is great", timestamp: new Date().toISOString() });
      appendEntry(ctx, id, { role: "agent", content: "Python is also great", timestamp: new Date().toISOString() });
      const results = searchEntries(ctx, "TypeScript", id);
      expect(results.length).toBe(1);
      expect(results[0].content).toContain("TypeScript");
    });

    it("applies 50% keyword threshold (1 of 2 keywords matches → included)", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, { role: "user", content: "TypeScript rocks", timestamp: new Date().toISOString() });
      // "TypeScript python" — entry contains "TypeScript" (1/2 = 50% ≥ threshold)
      const results = searchEntries(ctx, "TypeScript python", id);
      expect(results.length).toBe(1);
    });

    it("excludes entries below 50% threshold (0 of 2 keywords match)", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, { role: "user", content: "Go is fast", timestamp: new Date().toISOString() });
      const results = searchEntries(ctx, "TypeScript Python", id);
      expect(results.length).toBe(0);
    });

    it("searches only compressed entries when mode is 'compressed'", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, { role: "user", content: "original typescript", timestamp: new Date().toISOString() }, false);
      appendEntry(ctx, id, { role: "user", content: "compressed typescript", timestamp: new Date().toISOString() }, true);
      const results = searchEntries(ctx, "typescript", id, "compressed");
      expect(results.length).toBe(1);
      expect(results[0].content).toBe("compressed typescript");
    });

    it("searches all sessions when sessionId is omitted", () => {
      const id1 = createSession(ctx);
      const id2 = createSession(ctx);
      appendEntry(ctx, id1, { role: "user", content: "session one typescript", timestamp: new Date().toISOString() });
      appendEntry(ctx, id2, { role: "user", content: "session two typescript", timestamp: new Date().toISOString() });
      const results = searchEntries(ctx, "typescript");
      expect(results.length).toBe(2);
    });
  });

  // ─── searchAcrossSessions ───────────────────────────────────────────────────

  describe("searchAcrossSessions", () => {
    it("returns results grouped by session", () => {
      const id1 = createSession(ctx);
      const id2 = createSession(ctx);
      appendEntry(ctx, id1, { role: "user", content: "typescript test", timestamp: new Date().toISOString() });
      appendEntry(ctx, id2, { role: "user", content: "typescript prod", timestamp: new Date().toISOString() });
      const results = searchAcrossSessions(ctx, "typescript");
      expect(results.length).toBe(2);
      expect(results.every((r) => r.entries.length > 0)).toBe(true);
    });

    it("filters by tags when provided", () => {
      const id1 = createSession(ctx);
      const id2 = createSession(ctx);
      updateSessionMeta(ctx, id1, { tags: ["typescript"] });
      appendEntry(ctx, id1, { role: "user", content: "typescript code", timestamp: new Date().toISOString() });
      appendEntry(ctx, id2, { role: "user", content: "typescript code", timestamp: new Date().toISOString() });
      const results = searchAcrossSessions(ctx, "typescript", "both", ["typescript"]);
      expect(results.length).toBe(1);
      expect(results[0].sessionId).toBe(id1);
    });

    it("returns empty array when no sessions match", () => {
      const results = searchAcrossSessions(ctx, "zzznomatch");
      expect(results).toEqual([]);
    });
  });

  // ─── truncateHistoryAfterIndex ───────────────────────────────────────────────

  describe("truncateHistoryAfterIndex", () => {
    it("removes entries after the given index (keeps 0..keepThroughIndex inclusive)", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, { role: "user", content: "a", timestamp: new Date().toISOString() });
      appendEntry(ctx, id, { role: "agent", content: "b", timestamp: new Date().toISOString() });
      appendEntry(ctx, id, { role: "user", content: "c", timestamp: new Date().toISOString() });
      truncateHistoryAfterIndex(ctx, id, 1);
      const session = getSession(ctx, id);
      expect(session?.original.length).toBe(2);
      expect(session?.original[0].content).toBe("a");
      expect(session?.original[1].content).toBe("b");
    });

    it("keeps all entries when keepThroughIndex is last index", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, { role: "user", content: "x", timestamp: new Date().toISOString() });
      appendEntry(ctx, id, { role: "agent", content: "y", timestamp: new Date().toISOString() });
      truncateHistoryAfterIndex(ctx, id, 1);
      const session = getSession(ctx, id);
      expect(session?.original.length).toBe(2);
    });

    it("clears all original entries when keepThroughIndex is -1", () => {
      const id = createSession(ctx);
      appendEntry(ctx, id, { role: "user", content: "only", timestamp: new Date().toISOString() });
      truncateHistoryAfterIndex(ctx, id, -1);
      const session = getSession(ctx, id);
      expect(session?.original.length).toBe(0);
    });

    it("does nothing for non-existent session (no throw)", () => {
      expect(() => truncateHistoryAfterIndex(ctx, "no-such-id", 0)).not.toThrow();
    });
  });
});
