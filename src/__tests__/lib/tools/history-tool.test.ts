import { describe, it, expect, beforeEach } from "bun:test";
import { historyFindTool, historySearchAllTool, historyGetSessionTool } from "@/lib/tools/history-tool";
import { makeTestContext } from "../../helpers/fakes";
import { createSession, appendEntry } from "@/lib/history";
import type { ToolContext } from "@/lib/tools/types";
import type { HistoryEntry } from "@/lib/types";

function makeToolCtx(sessionId: string): ToolContext {
  const ctx = makeTestContext();
  return { ...ctx, agentId: "agent-1", sessionId, volumeRoot: "/workspace" };
}

describe("historyFindTool", () => {
  it("finds entries in the current session by keyword", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, { role: "user", content: "Tell me about TypeScript interfaces", timestamp: new Date().toISOString() });
    appendEntry(ctx, sessionId, { role: "agent", content: "Sure! TypeScript interfaces define contracts.", timestamp: new Date().toISOString() });
    const toolCtx: ToolContext = { ...ctx, agentId: "agent-1", sessionId, volumeRoot: "/workspace" };
    const results = await historyFindTool.execute({ query: "TypeScript" }, toolCtx) as HistoryEntry[];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("TypeScript");
  });

  it("returns empty array when no matches", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, { role: "user", content: "Hello world", timestamp: new Date().toISOString() });
    const toolCtx: ToolContext = { ...ctx, agentId: "agent-1", sessionId, volumeRoot: "/workspace" };
    const results = await historyFindTool.execute({ query: "zzznomatches" }, toolCtx) as HistoryEntry[];
    expect(results).toHaveLength(0);
  });

  it("respects mode=compressed filter", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    // Insert original and compressed entries directly
    appendEntry(ctx, sessionId, { role: "user", content: "original content", timestamp: new Date().toISOString() }, false);
    appendEntry(ctx, sessionId, { role: "user", content: "compressed content", timestamp: new Date().toISOString() }, true);
    const toolCtx: ToolContext = { ...ctx, agentId: "agent-1", sessionId, volumeRoot: "/workspace" };
    const results = await historyFindTool.execute({ query: "content", mode: "compressed" }, toolCtx) as HistoryEntry[];
    // Should only return compressed entries (is_compressed=1)
    expect(results.every((e) => e.content === "compressed content")).toBe(true);
  });
});

describe("historySearchAllTool", () => {
  it("searches across all sessions", async () => {
    const ctx = makeTestContext();
    const s1 = createSession(ctx, ["user", "maia"]);
    const s2 = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, s1, { role: "user", content: "Python is great for data science", timestamp: new Date().toISOString() });
    appendEntry(ctx, s2, { role: "user", content: "Python decorators are powerful", timestamp: new Date().toISOString() });
    const toolCtx: ToolContext = { ...ctx, agentId: "a", sessionId: s1, volumeRoot: "/w" };
    const results = await historySearchAllTool.execute({ query: "Python" }, toolCtx) as Array<{ sessionId: string; entries: HistoryEntry[] }>;
    expect(results.length).toBeGreaterThan(0);
    const allEntries = results.flatMap((r) => r.entries);
    expect(allEntries.every((e) => e.content.includes("Python"))).toBe(true);
  });

  it("filters by tag when tags param is provided", async () => {
    const ctx = makeTestContext();
    const s1 = createSession(ctx, ["user", "maia"]);
    ctx.db.prepare("UPDATE sessions SET tags = ? WHERE id = ?").run(JSON.stringify(["ml"]), s1);
    appendEntry(ctx, s1, { role: "user", content: "Machine learning models", timestamp: new Date().toISOString() });
    const s2 = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, s2, { role: "user", content: "Machine learning data", timestamp: new Date().toISOString() });
    const toolCtx: ToolContext = { ...ctx, agentId: "a", sessionId: s1, volumeRoot: "/w" };
    const results = await historySearchAllTool.execute({ query: "Machine", tags: "ml" }, toolCtx) as Array<{ sessionId: string }>;
    // Only the session tagged with "ml" should appear
    expect(results.every((r) => r.sessionId === s1)).toBe(true);
  });
});

describe("historyGetSessionTool", () => {
  it("returns null for nonexistent session", async () => {
    const ctx = makeTestContext();
    const toolCtx: ToolContext = { ...ctx, agentId: "a", sessionId: "x", volumeRoot: "/w" };
    const result = await historyGetSessionTool.execute({ sessionId: "nonexistent" }, toolCtx);
    expect(result).toBeNull();
  });

  it("returns full session by default", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, { role: "user", content: "hello", timestamp: new Date().toISOString() });
    const toolCtx: ToolContext = { ...ctx, agentId: "a", sessionId, volumeRoot: "/w" };
    const result = await historyGetSessionTool.execute({ sessionId }, toolCtx) as { id: string; original: HistoryEntry[] };
    expect(result.id).toBe(sessionId);
    expect(result.original).toHaveLength(1);
  });

  it("returns only compressed entries when mode=compressed", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, { role: "user", content: "original", timestamp: new Date().toISOString() }, false);
    appendEntry(ctx, sessionId, { role: "user", content: "compressed", timestamp: new Date().toISOString() }, true);
    const toolCtx: ToolContext = { ...ctx, agentId: "a", sessionId, volumeRoot: "/w" };
    const result = await historyGetSessionTool.execute({ sessionId, mode: "compressed" }, toolCtx) as { original: HistoryEntry[]; compressed: HistoryEntry[] };
    expect(result.original).toHaveLength(0);
    expect(result.compressed).toHaveLength(1);
  });

  it("returns only requested indexes when indexes array is provided", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, { role: "user", content: "turn0", timestamp: new Date().toISOString() }, false);
    appendEntry(ctx, sessionId, { role: "agent", content: "turn1", timestamp: new Date().toISOString() }, false);
    appendEntry(ctx, sessionId, { role: "user", content: "turn2", timestamp: new Date().toISOString() }, false);
    appendEntry(ctx, sessionId, { role: "agent", content: "turn3", timestamp: new Date().toISOString() }, false);
    const toolCtx: ToolContext = { ...ctx, agentId: "a", sessionId, volumeRoot: "/w" };
    const result = await historyGetSessionTool.execute(
      { sessionId, mode: "original", indexes: [0, 2] },
      toolCtx
    ) as { sessionId: string; mode: string; entries: Array<{ index: number; original?: HistoryEntry }> };
    expect(result.sessionId).toBe(sessionId);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ index: 0, original: expect.objectContaining({ content: "turn0" }) });
    expect(result.entries[1]).toMatchObject({ index: 2, original: expect.objectContaining({ content: "turn2" }) });
  });

  it("returns only requested range when rangeStart and rangeEnd are provided", async () => {
    const ctx = makeTestContext();
    const sessionId = createSession(ctx, ["user", "maia"]);
    appendEntry(ctx, sessionId, { role: "user", content: "a", timestamp: new Date().toISOString() }, false);
    appendEntry(ctx, sessionId, { role: "agent", content: "b", timestamp: new Date().toISOString() }, false);
    appendEntry(ctx, sessionId, { role: "user", content: "c", timestamp: new Date().toISOString() }, false);
    appendEntry(ctx, sessionId, { role: "agent", content: "d", timestamp: new Date().toISOString() }, false);
    const toolCtx: ToolContext = { ...ctx, agentId: "a", sessionId, volumeRoot: "/w" };
    const result = await historyGetSessionTool.execute(
      { sessionId, mode: "original", rangeStart: 1, rangeEnd: 2 },
      toolCtx
    ) as { sessionId: string; entries: Array<{ index: number; original?: HistoryEntry }> };
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({ index: 1, original: expect.objectContaining({ content: "b" }) });
    expect(result.entries[1]).toMatchObject({ index: 2, original: expect.objectContaining({ content: "c" }) });
  });
});
