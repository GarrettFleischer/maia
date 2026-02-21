import { describe, it, expect, beforeEach } from "bun:test";
import { compressEntry } from "@/lib/agent/compression";
import { makeTestContext } from "../../helpers/fakes";
import { createSession } from "@/lib/history";
import type { AppContext } from "@/lib/context";
import type { AIProvider } from "@/lib/ai/types";
import type { HistoryEntry } from "@/lib/types";

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "entry-1",
    role: "user",
    content: "What is the capital of France?",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockProvider(responseContent: string): AIProvider {
  return {
    async complete(_messages, _tools, onToken) {
      onToken(responseContent);
      return { content: responseContent, toolCalls: [], stopped: true };
    },
  };
}

describe("compressEntry", () => {
  let ctx: AppContext;
  let sessionId: string;

  beforeEach(() => {
    ctx = makeTestContext();
    sessionId = createSession(ctx, ["user", "maia"]);
  });

  it("stores entry as-is when provider is null", async () => {
    const entry = makeEntry({ content: "Hello world" });
    const result = await compressEntry(ctx, null, entry, sessionId);
    expect(result.content).toBe("Hello world");
    expect(result.role).toBe("user");
    // Should be in DB as compressed
    const rows = ctx.db
      .prepare("SELECT * FROM history_entries WHERE session_id = ? AND is_compressed = 1")
      .all(sessionId) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
  });

  it("uses provider to compress content", async () => {
    const compressedResponse = JSON.stringify({
      content: "User asked about Paris being France's capital.",
      role: "user",
    });
    const provider = makeMockProvider(compressedResponse);
    const entry = makeEntry({ content: "What is the capital of France? I heard it might be Paris." });
    const result = await compressEntry(ctx, provider, entry, sessionId);
    expect(result.content).toBe("User asked about Paris being France's capital.");
  });

  it("falls back to original content when provider returns unparseable JSON", async () => {
    const provider = makeMockProvider("not valid json at all");
    const entry = makeEntry({ content: "Original content" });
    const result = await compressEntry(ctx, provider, entry, sessionId);
    expect(result.content).toBe("Original content");
  });

  it("falls back to original content when provider throws", async () => {
    const provider: AIProvider = {
      async complete() {
        throw new Error("Network error");
      },
    };
    const entry = makeEntry({ content: "Fallback content" });
    const result = await compressEntry(ctx, provider, entry, sessionId);
    expect(result.content).toBe("Fallback content");
  });

  it("preserves role from the original entry", async () => {
    const provider = makeMockProvider(JSON.stringify({ content: "compressed", role: "agent" }));
    const entry = makeEntry({ role: "agent", content: "I can help you with that." });
    const result = await compressEntry(ctx, provider, entry, sessionId);
    expect(result.role).toBe("agent");
  });

  it("preserves toolName and toolArgs from original entry", async () => {
    const provider = makeMockProvider(JSON.stringify({ content: "used file_read tool" }));
    const entry = makeEntry({
      role: "tool_call",
      toolName: "file_read",
      toolArgs: { path: "/test.txt" },
    });
    const result = await compressEntry(ctx, provider, entry, sessionId);
    expect(result.toolName).toBe("file_read");
    expect(result.toolArgs).toEqual({ path: "/test.txt" });
  });

  it("updates session tags when provider returns tags", async () => {
    const provider = makeMockProvider(
      JSON.stringify({ content: "compressed", tags: ["important", "project-x"] })
    );
    const entry = makeEntry();
    await compressEntry(ctx, provider, entry, sessionId);
    const row = ctx.db
      .prepare("SELECT tags FROM sessions WHERE id = ?")
      .get(sessionId) as { tags: string };
    const tags = JSON.parse(row.tags);
    expect(tags).toContain("important");
    expect(tags).toContain("project-x");
  });

  it("merges new tags with existing session tags", async () => {
    // Seed session with existing tags
    ctx.db.prepare("UPDATE sessions SET tags = ? WHERE id = ?").run(
      JSON.stringify(["existing"]),
      sessionId
    );
    const provider = makeMockProvider(JSON.stringify({ content: "c", tags: ["new-tag"] }));
    await compressEntry(ctx, provider, makeEntry(), sessionId);
    const row = ctx.db.prepare("SELECT tags FROM sessions WHERE id = ?").get(sessionId) as { tags: string };
    const tags = JSON.parse(row.tags);
    expect(tags).toContain("existing");
    expect(tags).toContain("new-tag");
  });
});
