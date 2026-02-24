import path from "path";
import { describe, it, expect, beforeEach } from "bun:test";
import { runAgent } from "@/lib/agent/runner";
import { makeTestContext, FakeEvents, FakeResponse, FakeFs } from "../../helpers/fakes";
import { updateSettings } from "@/lib/settings";
import { createSession, appendEntry } from "@/lib/history";
import { getAgentsDir } from "@/lib/data-dir";
import type { AppContext } from "@/lib/context";
import type { AIProvider, AIResponse } from "@/lib/ai/types";
import type { SSEEvent } from "@/lib/types";
import type { ProviderFactory } from "@/lib/agent/runner";

function seedIdentityFiles(fs: FakeFs, agentId: string) {
  const dir = path.join(getAgentsDir(), agentId);
  fs.seed(path.join(dir, "SOUL.md"), "# Soul\nI am Maia, the orchestrator.");
  fs.seed(path.join(dir, "MEMORY.md"), "# Memory\nUser prefers TDD.");
  fs.seed(path.join(dir, "GOALS.md"), "# Goals\n- [ ] Coordinate agents");
  fs.seed(path.join(dir, "USER.md"), "# User\nThe user is a developer.");
}

function seedAgent(ctx: AppContext, id = "maia", model = "ollama/llama3.2") {
  const now = new Date().toISOString();
  ctx.db.prepare(
    "INSERT INTO agents (id, name, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, id, model, "active", now, now);
}

function makeSimpleProvider(response: Partial<AIResponse> = {}): AIProvider {
  return {
    async complete(_messages, _tools, onToken) {
      const content = response.content ?? "I can help you with that.";
      onToken(content);
      return { content, toolCalls: response.toolCalls ?? [], stopped: true };
    },
  };
}

function makeProviderFactory(provider: AIProvider): ProviderFactory {
  return () => provider;
}

describe("runAgent", () => {
  let ctx: AppContext;
  let sessionId: string;
  const events: SSEEvent[] = [];

  beforeEach(() => {
    ctx = makeTestContext();
    events.length = 0;
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2"] });
    seedAgent(ctx);
    sessionId = createSession(ctx, ["user", "maia"]);
    // Stub embeddings so history index (fire-and-forget) does not throw
    (ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async () => new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] }))
    );
  });

  it("throws when agent does not exist", async () => {
    await expect(
      runAgent(ctx, makeProviderFactory(makeSimpleProvider()), "nonexistent", sessionId, "hi", () => {})
    ).rejects.toThrow();
  });

  it("throws when agent's model is not whitelisted", async () => {
    seedAgent(ctx, "bot-evil", "evil-model");
    await expect(
      runAgent(ctx, makeProviderFactory(makeSimpleProvider()), "bot-evil", sessionId, "hi", () => {})
    ).rejects.toThrow();
  });

  it("emits token events during response", async () => {
    const received: string[] = [];
    await runAgent(ctx, makeProviderFactory(makeSimpleProvider({ content: "hello there" })), "maia", sessionId, "hi", (e) => {
      if (e.type === "token") received.push(e.content);
    });
    expect(received.join("")).toBe("hello there");
  });

  it("emits done event at the end", async () => {
    const doneEvents: SSEEvent[] = [];
    await runAgent(ctx, makeProviderFactory(makeSimpleProvider()), "maia", sessionId, "hi", (e) => {
      if (e.type === "done") doneEvents.push(e);
    });
    expect(doneEvents).toHaveLength(1);
    expect((doneEvents[0] as { type: "done"; sessionId: string }).sessionId).toBe(sessionId);
  });

  it("stores user and agent entries in history", async () => {
    await runAgent(ctx, makeProviderFactory(makeSimpleProvider({ content: "Agent response" })), "maia", sessionId, "User message", () => {});
    const rows = ctx.db
      .prepare("SELECT * FROM history_entries WHERE session_id = ? AND is_compressed = 0 ORDER BY timestamp ASC")
      .all(sessionId) as Record<string, unknown>[];
    expect(rows.some((r) => r.role === "user" && r.content === "User message")).toBe(true);
    expect(rows.some((r) => r.role === "agent" && r.content === "Agent response")).toBe(true);
  });

  it("sets agent status to running during execution, then back to idle", async () => {
    const statuses: string[] = [];
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        // Capture status during execution
        const mid = ctx.db.prepare("SELECT status FROM agents WHERE id = ?").get("maia") as { status: string };
        statuses.push(mid.status);
        onToken("response");
        return { content: "response", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "hi", () => {});
    expect(statuses).toContain("running");
    const final = ctx.db.prepare("SELECT status FROM agents WHERE id = ?").get("maia") as { status: string };
    expect(final.status).toBe("idle");
  });

  it("resets agent to idle even if provider throws", async () => {
    const provider: AIProvider = {
      async complete() { throw new Error("Provider error"); },
    };
    await expect(runAgent(ctx, () => provider, "maia", sessionId, "hi", () => {})).rejects.toThrow();
    const row = ctx.db.prepare("SELECT status FROM agents WHERE id = ?").get("maia") as { status: string };
    expect(row.status).toBe("idle");
  });

  it("executes tool calls and loops", async () => {
    let callCount = 0;
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        callCount++;
        if (callCount === 1) {
          // First: return a tool call (but no tool registered, so it'll use "unknown tool" path)
          return {
            content: "",
            toolCalls: [{ id: "tc-1", name: "nonexistent_tool", args: {} }],
            stopped: false,
          };
        }
        // Second: final response
        onToken("Done");
        return { content: "Done", toolCalls: [], stopped: true };
      },
    };
    const toolEvents: SSEEvent[] = [];
    await runAgent(ctx, () => provider, "maia", sessionId, "do something", (e) => {
      if (e.type === "tool_call" || e.type === "tool_result") toolEvents.push(e);
    });
    // 2 from agentic loop (tool call then final) + 2 from compressEntry (user + agent entry) when compression model matches agent model
    expect(callCount).toBe(4);
    expect(toolEvents.some((e) => e.type === "tool_call")).toBe(true);
    expect(toolEvents.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("excludes empty compressed entries from context (skipped turns)", async () => {
    const t1 = "2020-01-01T00:00:01.000Z";
    const t2 = "2020-01-01T00:00:02.000Z";
    const t3 = "2020-01-01T00:00:03.000Z";
    appendEntry(ctx, sessionId, { role: "user", content: "prior data", timestamp: t1 }, true);
    appendEntry(ctx, sessionId, { role: "agent", content: "", timestamp: t2 }, true);
    appendEntry(ctx, sessionId, { role: "user", content: "second", timestamp: t3 }, true);
    let capturedMessages: { role: string; content: string }[] = [];
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        // Capture only the main agent call (context has "prior data"); compression runs later with different messages.
        const nonSystem = messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : String(m.content) }));
        if (nonSystem.some((m) => m.content.includes("prior data")) || nonSystem.some((m) => m.content === "current"))
          capturedMessages = nonSystem;
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "current", () => {});
    // Empty compressed entry must not appear in context; no message should have empty content.
    expect(capturedMessages.every((m) => m.content.trim() !== "")).toBe(true);
    const contents = capturedMessages.map((m) => m.content);
    expect(contents).toContain("current");
    expect(contents).toContain("prior data");
  });

  it("includes the running agent's own MD files (SOUL, MEMORY, GOALS, USER) in the system prompt", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    (ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }).on(
      "/api/embed",
      async () => new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] }))
    );

    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        if (system && typeof system.content === "string" && system.content.includes("## Identity"))
          systemContent = system.content;
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "Hello", () => {});

    expect(systemContent).toContain("I am Maia, the orchestrator.");
    expect(systemContent).toContain("User prefers TDD.");
    expect(systemContent).toContain("Coordinate agents");
    expect(systemContent).toContain("The user is a developer.");
    expect(systemContent).toContain("## Identity");
    expect(systemContent).toContain("## Memory");
    expect(systemContent).toContain("## Goals");
    expect(systemContent).toContain("## User");
  });

  it("emits tool_result with error when registered tool receives invalid args (parse throws)", async () => {
    let callCount = 0;
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        callCount++;
        if (callCount === 1) {
          onToken("");
          return {
            content: "",
            toolCalls: [{ id: "tc-1", name: "agent_create", args: {} }],
            stopped: false,
          };
        }
        onToken("Done");
        return { content: "Done", toolCalls: [], stopped: true };
      },
    };
    const toolResults: SSEEvent[] = [];
    await runAgent(ctx, () => provider, "maia", sessionId, "create agent", (e) => {
      if (e.type === "tool_result") toolResults.push(e);
    });
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    const errResult = toolResults.find((e) => e.type === "tool_result" && typeof (e as { result: { error?: string } }).result?.error === "string");
    expect(errResult).toBeDefined();
  });
});
