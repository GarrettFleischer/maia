/**
 * @fileoverview Tests for the core agent runner loop and system prompt construction, including identity loading and system date/time section.
 * @module __tests__/lib/agent/runner.test
 */
import path from "path";
import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { runAgent } from "@/lib/agent/runner";
import { registerLlmQueueHandlers } from "@/lib/queue/llm-queue-handlers";
import {
  makeTestContext,
  FakeEvents,
  FakeResponse,
  FakeFs,
  FakeHttp,
} from "../../helpers/fakes";
import { updateSettings } from "@/lib/settings";
import { createSession, appendEntry } from "@/lib/history";
import { getAgentsDir } from "@/lib/data-dir";
import type { AppContext } from "@/lib/context";
import type { AIProvider, AIResponse } from "@/lib/ai/types";
import type { SSEEvent } from "@/lib/types";
import type { ProviderFactory } from "@/lib/agent/runner";

function seedIdentityFiles(
  fs: FakeFs,
  agentId: string,
  options?: { agentsMd?: string },
) {
  const dir = path.join(getAgentsDir(), agentId);
  fs.seed(path.join(dir, "SOUL.md"), "# Soul\nI am Maia, the orchestrator.");
  fs.seed(path.join(dir, "MEMORY.md"), "# Memory\nUser prefers TDD.");
  fs.seed(path.join(dir, "USER.md"), "# User\nThe user is a developer.");
  if (options?.agentsMd !== undefined) {
    fs.seed(path.join(dir, "AGENTS.md"), options.agentsMd);
  }
}

function seedAgent(ctx: AppContext, id = "maia", model = "ollama/llama3.2") {
  const now = new Date().toISOString();
  ctx.db
    .prepare(
      "INSERT INTO agents (id, name, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, id, model, "active", now, now);
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
    registerLlmQueueHandlers();
    ctx = makeTestContext();
    events.length = 0;
    updateSettings(ctx, {
      whitelistedModels: ["ollama/llama3.2", "ollama/nomic-embed-text"],
    });
    seedAgent(ctx);
    sessionId = createSession(ctx, ["user", "maia"]);
    // Stub embeddings so history index (fire-and-forget) does not throw
    (
      ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }
    ).on(
      "/api/embed",
      async () =>
        new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] })),
    );
  });

  it("throws when agent does not exist", async () => {
    await expect(
      runAgent(
        ctx,
        makeProviderFactory(makeSimpleProvider()),
        "nonexistent",
        sessionId,
        "hi",
        () => {},
      ),
    ).rejects.toThrow();
  });

  it("throws when agent's model is not whitelisted", async () => {
    seedAgent(ctx, "bot-evil", "evil-model");
    await expect(
      runAgent(
        ctx,
        makeProviderFactory(makeSimpleProvider()),
        "bot-evil",
        sessionId,
        "hi",
        () => {},
      ),
    ).rejects.toThrow();
  });

  it("emits token events during response", async () => {
    const received: string[] = [];
    await runAgent(
      ctx,
      makeProviderFactory(makeSimpleProvider({ content: "hello there" })),
      "maia",
      sessionId,
      "hi",
      (e) => {
        if (e.type === "token") received.push(e.content);
      },
    );
    expect(received.join("")).toBe("hello there");
  });

  it("emits done event at the end", async () => {
    const doneEvents: SSEEvent[] = [];
    await runAgent(
      ctx,
      makeProviderFactory(makeSimpleProvider()),
      "maia",
      sessionId,
      "hi",
      (e) => {
        if (e.type === "done") doneEvents.push(e);
      },
    );
    expect(doneEvents).toHaveLength(1);
    expect(
      (doneEvents[0] as { type: "done"; sessionId: string }).sessionId,
    ).toBe(sessionId);
  });

  it("stores user and agent entries in history", async () => {
    await runAgent(
      ctx,
      makeProviderFactory(makeSimpleProvider({ content: "Agent response" })),
      "maia",
      sessionId,
      "User message",
      () => {},
    );
    const rows = ctx.db
      .prepare(
        "SELECT * FROM history_entries WHERE session_id = ? AND is_compressed = 0 ORDER BY timestamp ASC",
      )
      .all(sessionId) as Record<string, unknown>[];
    expect(
      rows.some((r) => r.role === "user" && r.content === "User message"),
    ).toBe(true);
    expect(
      rows.some((r) => r.role === "agent" && r.content === "Agent response"),
    ).toBe(true);
  });

  it("stores resolved command and round index for the user entry", async () => {
    await runAgent(
      ctx,
      makeProviderFactory(makeSimpleProvider({ content: "Agent response" })),
      "maia",
      sessionId,
      "User message",
      () => {},
    );
    const rows = ctx.db
      .prepare(
        "SELECT role, content, resolved_content, round_index FROM history_entries WHERE session_id = ? AND is_compressed = 0 ORDER BY timestamp ASC",
      )
      .all(sessionId) as {
      role: string;
      content: string;
      resolved_content: string | null;
      round_index: number | null;
    }[];
    const userRow = rows.find((r) => r.role === "user");
    expect(userRow).toBeDefined();
    expect(userRow?.content).toBe("User message");
    expect(userRow?.resolved_content).toBe("User message");
    expect(userRow?.round_index).toBe(1);
  });

  it("sets agent status to running during execution, then back to idle", async () => {
    const statuses: string[] = [];
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        // Capture status during execution
        const mid = ctx.db
          .prepare("SELECT status FROM agents WHERE id = ?")
          .get("maia") as { status: string };
        statuses.push(mid.status);
        onToken("response");
        return { content: "response", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "hi",
      () => {},
    );
    expect(statuses).toContain("running");
    const final = ctx.db
      .prepare("SELECT status FROM agents WHERE id = ?")
      .get("maia") as { status: string };
    expect(final.status).toBe("idle");
  });

  it("resets agent to idle even if provider throws", async () => {
    const provider: AIProvider = {
      async complete() {
        throw new Error("Provider error");
      },
    };
    await expect(
      runAgent(
        ctx,
        () => provider,
        "maia",
        sessionId,
        "hi",
        () => {},
      ),
    ).rejects.toThrow();
    const row = ctx.db
      .prepare("SELECT status FROM agents WHERE id = ?")
      .get("maia") as { status: string };
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
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "do something",
      (e) => {
        if (e.type === "tool_call" || e.type === "tool_result")
          toolEvents.push(e);
      },
    );
    // 2 from agentic loop (tool call then final); compression runs in background and does not call the provider
    expect(callCount).toBe(2);
    expect(toolEvents.some((e) => e.type === "tool_call")).toBe(true);
    expect(toolEvents.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("system prompt omits last 3 rounds (smart context used instead); current user message is the only user turn in messages", async () => {
    const t1 = "2020-01-01T00:00:01.000Z";
    const t2 = "2020-01-01T00:00:02.000Z";
    appendEntry(
      ctx,
      sessionId,
      { role: "user", content: "prior user message", timestamp: t1 },
      false,
    );
    appendEntry(
      ctx,
      sessionId,
      { role: "agent", content: "prior agent reply", timestamp: t2 },
      false,
    );
    let capturedSystem = "";
    let capturedNonSystem: { role: string; content: string }[] = [];
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        const nonSystem = messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role,
            content:
              typeof m.content === "string" ? m.content : String(m.content),
          }));
        capturedSystem =
          system && typeof system.content === "string" ? system.content : "";
        capturedNonSystem = nonSystem;
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "current",
      () => {},
    );
    expect(capturedSystem).not.toContain("## Recent thread");
    expect(capturedSystem).toContain("You are agent");
    expect(capturedNonSystem).toHaveLength(1);
    expect(capturedNonSystem[0].content).toBe("current");
    expect(capturedNonSystem[0].role).toBe("user");
  });

  it("system prompt omits last 3 rounds with prior message and reply", async () => {
    const t0 = "2020-01-01T00:00:00.000Z";
    const t1 = "2020-01-01T00:00:01.000Z";
    appendEntry(
      ctx,
      sessionId,
      { role: "user", content: "prior message", timestamp: t0 },
      false,
    );
    appendEntry(
      ctx,
      sessionId,
      { role: "agent", content: "prior reply", timestamp: t1 },
      false,
    );
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent =
          system && typeof system.content === "string" ? system.content : "";
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "current",
      () => {},
    );
    expect(systemContent).not.toContain("## Recent thread");
    expect(systemContent).toContain("You are agent");
  });

  it("system message omits last 3 rounds (smart context and find_tool used for prior context)", async () => {
    const t0 = "2020-01-01T00:00:00.000Z";
    const t1 = "2020-01-01T00:00:01.000Z";
    appendEntry(
      ctx,
      sessionId,
      { role: "user", content: "first user", timestamp: t0 },
      false,
    );
    appendEntry(
      ctx,
      sessionId,
      { role: "agent", content: "first reply", timestamp: t1 },
      false,
    );
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent =
          system && typeof system.content === "string" ? system.content : "";
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "current",
      () => {},
    );
    expect(systemContent).not.toContain("## Recent thread");
    expect(systemContent).toContain("You are agent");
  });

  it("system omits last 3 rounds when session has history (tool_call and agent)", async () => {
    const t0 = "2020-01-01T00:00:00.000Z";
    const t1 = "2020-01-01T00:00:01.000Z";
    const t2 = "2020-01-01T00:00:02.000Z";
    const t3 = "2020-01-01T00:00:03.000Z";

    appendEntry(
      ctx,
      sessionId,
      { role: "user", content: "only user", timestamp: t0 },
      false,
    );
    appendEntry(
      ctx,
      sessionId,
      { role: "agent", content: "only reply", timestamp: t1 },
      false,
    );
    appendEntry(
      ctx,
      sessionId,
      {
        role: "tool_call",
        content: "only tool",
        toolName: "single_tool",
        toolArgs: { value: 1 },
        timestamp: t2,
      },
      false,
    );
    appendEntry(
      ctx,
      sessionId,
      { role: "agent", content: "follow-up after tool", timestamp: t3 },
      false,
    );

    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent =
          system && typeof system.content === "string" ? system.content : "";
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };

    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "current",
      () => {},
    );

    expect(systemContent).not.toContain("## Recent thread");
    expect(systemContent).toContain("You are agent");
  });

  it("when more than 3 rounds exist, system includes find_tool note (no verbatim recent thread)", async () => {
    const ts = "2020-01-01T00:00:00.000Z";
    for (let i = 0; i < 4; i++) {
      appendEntry(
        ctx,
        sessionId,
        { role: "user", content: `user message ${i + 1}`, timestamp: ts },
        false,
      );
      appendEntry(
        ctx,
        sessionId,
        { role: "agent", content: `agent reply ${i + 1}`, timestamp: ts },
        false,
      );
    }
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent =
          system && typeof system.content === "string" ? system.content : "";
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "current",
      () => {},
    );
    expect(systemContent).not.toContain("## Recent thread");
    expect(systemContent).toContain("**find_tool**");
    expect(systemContent).toContain("You are agent");
  });

  it("system omits recent thread (no verbatim thinking or prior turns in system)", async () => {
    const ts = "2020-01-01T00:00:00.000Z";
    appendEntry(
      ctx,
      sessionId,
      { role: "user", content: "ask", timestamp: ts },
      false,
    );
    appendEntry(
      ctx,
      sessionId,
      { role: "thinking", content: "internal reasoning here", timestamp: ts },
      false,
    );
    appendEntry(
      ctx,
      sessionId,
      { role: "agent", content: "reply", timestamp: ts },
      false,
    );
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent =
          system && typeof system.content === "string" ? system.content : "";
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "current",
      () => {},
    );
    expect(systemContent).not.toContain("## Recent thread");
    expect(systemContent).toContain("You are agent");
  });

  it("puts system prompt in order: agent id, date/time, AGENTS, SOUL", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent =
          system && typeof system.content === "string" ? system.content : "";
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "Hello",
      () => {},
    );
    const agentIdPos = systemContent.indexOf("You are agent `maia`");
    const securityPos = systemContent.indexOf("SECURITY NOTICE");
    const soulPos = systemContent.indexOf("data/agents/maia/SOUL.md");
    expect(agentIdPos).toBeGreaterThanOrEqual(0);
    expect(securityPos).toBeGreaterThan(agentIdPos);
    expect(soulPos).toBeGreaterThan(securityPos);
  });

  it("system omits recent thread when first message (no prior rounds)", async () => {
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent =
          system && typeof system.content === "string" ? system.content : "";
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "First message",
      () => {},
    );
    expect(systemContent).not.toContain("## Recent thread");
    expect(systemContent).toContain("You are agent");
  });

  it("invokes provider once when smart context has no results; system contains agent prompt", async () => {
    // Do not set contextQueryModel so smart context uses fallback query + empty retrieval (no model calls).
    const capturedSystems: string[] = [];
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const sys = messages.find((m) => m.role === "system");
        if (sys && typeof sys.content === "string")
          capturedSystems.push(sys.content);
        onToken("Agent response");
        return { content: "Agent response", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "Hello",
      () => {},
    );
    expect(capturedSystems).toHaveLength(1);
    expect(capturedSystems[0]).toContain("You are agent");
  });

  it("includes the current system date and time section in the system prompt", async () => {
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        const content =
          system && typeof system.content === "string" ? system.content : "";
        if (content.includes("You are agent")) {
          systemContent = content;
        }
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };

    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "Hello",
      () => {},
    );

    expect(systemContent).toContain("## System date and time");
    expect(systemContent).toMatch(
      /Current system ISO datetime \(UTC\):\s*\d{4}-\d{2}-\d{2}T/,
    );
    expect(systemContent).toContain("Current system local datetime:");
  });

  it("includes the running agent's SOUL and AGENTS content in the system prompt (memory/user are in folders, retrieved via knowledge_search)", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    (
      ctx.http as { on: (p: string, h: () => Promise<FakeResponse>) => void }
    ).on(
      "/api/embed",
      async () =>
        new FakeResponse(200, JSON.stringify({ embeddings: [[0.1, 0.2]] })),
    );

    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        if (
          system &&
          typeof system.content === "string" &&
          system.content.includes("You are agent `maia`")
        )
          systemContent = system.content;
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "Hello",
      () => {},
    );

    expect(systemContent).toContain("You are agent `maia`");
    expect(systemContent).toContain("I am Maia, the orchestrator.");
    expect(systemContent).toContain("data/agents/maia/AGENTS.md");
    expect(systemContent).toContain("data/agents/maia/SOUL.md");
  });

  it("does not include How you function section when AGENTS.md is absent (agent dir and project root)", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        const content =
          system && typeof system.content === "string" ? system.content : "";
        if (content.includes("You are agent `maia`")) systemContent = content;
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "Hello",
      () => {},
    );
    expect(systemContent).not.toContain("## How you function");
    expect(systemContent).toContain("SECURITY NOTICE");
    expect(systemContent).toContain("data/agents/maia/SOUL.md");
  });

  it("when options.initialToolCall is set, executes that tool and sends result as first turn to the model", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    let firstRequestMessages: {
      role: string;
      content?: string;
      toolName?: string;
    }[] = [];
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        if (firstRequestMessages.length === 0)
          firstRequestMessages = messages.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : undefined,
            toolName: m.toolName,
          }));
        onToken("Acknowledged.");
        return { content: "Acknowledged.", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      makeProviderFactory(provider),
      "maia",
      sessionId,
      "[CRON] Run cron_echo",
      () => {},
      {
        initialToolCall: {
          name: "cron_echo",
          args: { message: "scheduled payload" },
        },
      },
    );
    expect(
      firstRequestMessages.some(
        (m) => m.role === "user" && m.content?.includes("[CRON]"),
      ),
    ).toBe(true);
    expect(
      firstRequestMessages.some(
        (m) =>
          m.role === "tool" &&
          m.toolName === "cron_echo" &&
          m.content === "scheduled payload",
      ),
    ).toBe(true);
  });

  it("stores tool calls in history so agents can retrieve them via find_tool", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    const now = new Date().toISOString();
    appendEntry(ctx, sessionId, {
      role: "user",
      content: "Search for X",
      timestamp: now,
    });
    appendEntry(ctx, sessionId, {
      role: "agent",
      content: "I'll search.",
      timestamp: now,
    });
    appendEntry(ctx, sessionId, {
      role: "tool_call",
      content: "Found 3 results.",
      toolName: "knowledge",
      toolArgs: { query: "X", limit: 5 },
      timestamp: now,
    });
    const rows = ctx.db
      .prepare(
        "SELECT role, tool_name, content FROM history_entries WHERE session_id = ? ORDER BY timestamp ASC",
      )
      .all(sessionId) as Array<{
      role: string;
      tool_name: string | null;
      content: string;
    }>;
    const toolEntry = rows.find(
      (r) => r.role === "tool_call" && r.tool_name === "knowledge",
    );
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.content).toBe("Found 3 results.");
  });

  it("invokes provider once per run when smart context has no results", async () => {
    // Do not set contextQueryModel so smart context uses fallback query + empty retrieval (no model calls).
    let completeCallCount = 0;
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        completeCallCount++;
        onToken("Reply");
        return { content: "Reply", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      makeProviderFactory(provider),
      "maia",
      sessionId,
      "Hello",
      () => {},
    );
    expect(completeCallCount).toBe(1);
  });

  it("runs data embeddings (buildEmbeddings) before smart context so retrieval sees current knowledge and history", async () => {
    const rebuildMod = await import("@/lib/knowledge/rebuild-embeddings");
    const buildSpy = spyOn(rebuildMod, "buildEmbeddings").mockResolvedValue({
      knowledgeIndexed: 0,
      knowledgeRemoved: 0,
      historyIndexed: 0,
    });
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        onToken("Reply");
        return { content: "Reply", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      makeProviderFactory(provider),
      "maia",
      sessionId,
      "Hello",
      () => {},
    );
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy.mock.calls[0][0]).toBe(ctx);
    buildSpy.mockRestore();
  });

  it("includes active skills in the final smart context done phase output", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");

    const contextQueryMod = await import("@/lib/agent/context-query");
    const smartBlockSpy = spyOn(
      contextQueryMod,
      "buildSmartContextBlock",
    ).mockResolvedValue({
      block: "## Smart context\n\nSummary here.",
      sourceIds: ["history:s1/entry-1", "knowledge:docs/guide.md"],
      sourceLabels: [
        "User asked about deployment.",
        "docs/guide.md excerpt...",
      ],
    });

    const skillsMod = await import("@/lib/skills");
    const skillsSpy = spyOn(
      skillsMod,
      "getMatchedSkillsContent",
    ).mockResolvedValue({
      content: "## Active skills\n\n### deploy-app\n\nDeploy instructions.",
      skillNames: ["deploy-app"],
    });

    const eventsForRun: SSEEvent[] = [];

    await runAgent(
      ctx,
      makeProviderFactory(makeSimpleProvider({ content: "ok" })),
      "maia",
      sessionId,
      "hi",
      (e) => {
        eventsForRun.push(e);
      },
    );

    const donePhases = eventsForRun.filter(
      (e) => e.type === "smart_context_phase" && e.phase === "done",
    ) as Array<
      Extract<SSEEvent, { type: "smart_context_phase"; phase: "done" }>
    >;

    expect(donePhases.length).toBeGreaterThan(0);
    const lastDone = donePhases[donePhases.length - 1]!;

    expect(lastDone.detail).toBeDefined();
    expect(lastDone.detail).toContain("sources");
    expect(lastDone.detail?.toLowerCase()).toContain("skill");

    expect(typeof lastDone.output).toBe("string");
    const out = String(lastDone.output);
    expect(out).toContain("Active skills");
    expect(out).toContain("deploy-app");

    expect(lastDone.fullPrompt).toBeDefined();
    expect(String(lastDone.fullPrompt)).toContain("--- SYSTEM ---");
    expect(String(lastDone.fullPrompt)).toContain("--- USER ---");

    smartBlockSpy.mockRestore();
    skillsSpy.mockRestore();
  });

  it("persists smart context run to session row as phases progress so refresh can restore retrieval and filter outputs", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");

    const historyMod = await import("@/lib/history");
    const originalUpdate = historyMod.updateSessionSmartContext;
    const updates: Array<{ sessionId: string; run: { phases: unknown[] } }> =
      [];

    const updateSpy = spyOn(
      historyMod,
      "updateSessionSmartContext",
    ).mockImplementation((ctxArg, sessionIdArg, runArg) => {
      updates.push({ sessionId: sessionIdArg, run: { phases: runArg.phases } });
      return originalUpdate(ctxArg, sessionIdArg, runArg, 0);
    });

    await runAgent(
      ctx,
      makeProviderFactory(makeSimpleProvider({ content: "ok" })),
      "maia",
      sessionId,
      "hi",
      () => {},
    );

    updateSpy.mockRestore();

    const forSession = updates.filter((u) => u.sessionId === sessionId);
    expect(forSession.length).toBeGreaterThan(1);
    const last = forSession[forSession.length - 1];
    expect(last.run.phases.length).toBeGreaterThan(0);
    // No duplicate phase entries: each phase appears at most once (update-in-place, not push).
    const phaseNames = last.run.phases.map(
      (p: { phase: string }) => p.phase,
    ) as string[];
    expect(new Set(phaseNames).size).toBe(phaseNames.length);
  });

  it("includes AGENTS.md from agent dir as full system command when present", async () => {
    const customInstruction =
      "Review GOALS every turn. Update MEMORY when you learn something important.";
    seedIdentityFiles(ctx.fs as FakeFs, "maia", {
      agentsMd: customInstruction,
    });
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        const content =
          system && typeof system.content === "string" ? system.content : "";
        if (
          content.includes("You are agent `maia`") &&
          content.includes(customInstruction)
        )
          systemContent = content;
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "Hello",
      () => {},
    );
    expect(systemContent).toContain(customInstruction);
    const agentIdPos = systemContent.indexOf("You are agent `maia`");
    const customPos = systemContent.indexOf(customInstruction);
    const soulAttributionPos = systemContent.indexOf(
      "data/agents/maia/SOUL.md",
    );
    expect(agentIdPos).toBeGreaterThanOrEqual(0);
    expect(customPos).toBeGreaterThan(agentIdPos);
    expect(soulAttributionPos).toBeGreaterThan(customPos);
  });

  it("falls back to project root AGENTS.md when agent dir has no AGENTS.md", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    const agentsMdPath = path.join(process.cwd(), "AGENTS.md");
    const agentsContent = "Fallback content from project root.";
    (ctx.fs as FakeFs).seed(agentsMdPath, agentsContent);
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        const content =
          system && typeof system.content === "string" ? system.content : "";
        if (
          content.includes("You are agent `maia`") &&
          content.includes(agentsContent)
        )
          systemContent = content;
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "Hello",
      () => {},
    );
    expect(systemContent).toContain(agentsContent);
    expect(systemContent).toContain("data/agents/maia/SOUL.md");
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
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "create agent",
      (e) => {
        if (e.type === "tool_result") toolResults.push(e);
      },
    );
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    const errResult = toolResults.find(
      (e) =>
        e.type === "tool_result" &&
        typeof (e as { result: { error?: string } }).result?.error === "string",
    );
    expect(errResult).toBeDefined();
  });

  it("includes only the most recent thinking bubble in the next request when tool calls follow", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    const THINKING_TEXT = "I will call cron_list to list jobs.";
    let secondRequestAssistantContent: string | undefined;
    let completeCallCount = 0;
    const provider: AIProvider = {
      async complete(messages, _tools, onToken, options) {
        completeCallCount++;
        if (completeCallCount === 1) {
          options?.onThinkingToken?.(THINKING_TEXT);
          onToken("");
          return {
            content: "",
            toolCalls: [{ id: "tc-1", name: "cron_list", args: {} }],
            stopped: false,
          };
        }
        const assistantMsg = [...messages]
          .reverse()
          .find((m) => m.role === "assistant");
        secondRequestAssistantContent =
          assistantMsg && typeof assistantMsg.content === "string"
            ? assistantMsg.content
            : undefined;
        onToken("Done.");
        return { content: "Done.", toolCalls: [], stopped: true };
      },
    };
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "list cron jobs",
      () => {},
    );
    expect(completeCallCount).toBe(2);
    expect(secondRequestAssistantContent).toBeDefined();
    expect(secondRequestAssistantContent).toContain("Reasoning:");
    expect(secondRequestAssistantContent).toContain(THINKING_TEXT);
    expect(secondRequestAssistantContent).toMatch(
      new RegExp(
        `^Reasoning: ${THINKING_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n\n`,
      ),
    );
  });

  it("emits tool_result with non-null result on success (never null)", async () => {
    let callCount = 0;
    const provider: AIProvider = {
      async complete(_messages, _tools, onToken) {
        callCount++;
        if (callCount === 1) {
          onToken("");
          return {
            content: "",
            toolCalls: [{ id: "tc-1", name: "cron_list", args: {} }],
            stopped: false,
          };
        }
        onToken("Done");
        return { content: "Done", toolCalls: [], stopped: true };
      },
    };
    const toolResults: SSEEvent[] = [];
    await runAgent(
      ctx,
      () => provider,
      "maia",
      sessionId,
      "list cron jobs",
      (e) => {
        if (e.type === "tool_result") toolResults.push(e);
      },
    );
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    const successResult = toolResults.find(
      (e) =>
        e.type === "tool_result" && (e as { result: unknown }).result != null,
    );
    expect(successResult).toBeDefined();
    expect((successResult as { result: unknown }).result).not.toBeNull();
    expect((successResult as { result: unknown }).result).not.toBeUndefined();
  });
});
