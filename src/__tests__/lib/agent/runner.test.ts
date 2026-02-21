import { describe, it, expect, beforeEach } from "bun:test";
import { runAgent } from "@/lib/agent/runner";
import { makeTestContext, FakeEvents } from "../../helpers/fakes";
import { updateSettings } from "@/lib/settings";
import { createSession } from "@/lib/history";
import type { AppContext } from "@/lib/context";
import type { AIProvider, AIResponse } from "@/lib/ai/types";
import type { SSEEvent } from "@/lib/types";
import type { ProviderFactory } from "@/lib/agent/runner";

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
