/**
 * @fileoverview Tests for the core agent runner loop and system prompt construction, including identity loading and system date/time section.
 * @module __tests__/lib/agent/runner.test
 */
import path from "path";
import { describe, it, expect, beforeEach } from "bun:test";
import { runAgent } from "@/lib/agent/runner";
import { registerLlmQueueHandlers } from "@/lib/queue/llm-queue-handlers";
import { makeTestContext, FakeEvents, FakeResponse, FakeFs, FakeHttp } from "../../helpers/fakes";
import { updateSettings } from "@/lib/settings";
import { createSession, appendEntry } from "@/lib/history";
import { getAgentsDir } from "@/lib/data-dir";
import type { AppContext } from "@/lib/context";
import type { AIProvider, AIResponse } from "@/lib/ai/types";
import type { SSEEvent } from "@/lib/types";
import type { ProviderFactory } from "@/lib/agent/runner";

function seedIdentityFiles(fs: FakeFs, agentId: string, options?: { agentsMd?: string }) {
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
    registerLlmQueueHandlers();
    ctx = makeTestContext();
    events.length = 0;
    updateSettings(ctx, { whitelistedModels: ["ollama/llama3.2", "ollama/nomic-embed-text"] });
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
    // 2 from agentic loop (tool call then final); compression runs in background and does not call the provider
    expect(callCount).toBe(2);
    expect(toolEvents.some((e) => e.type === "tool_call")).toBe(true);
    expect(toolEvents.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("includes prior thread turns in the recent thread section of the system message", async () => {
    const t1 = "2020-01-01T00:00:01.000Z";
    const t2 = "2020-01-01T00:00:02.000Z";
    appendEntry(ctx, sessionId, { role: "user", content: "prior user message", timestamp: t1 }, false);
    appendEntry(ctx, sessionId, { role: "agent", content: "prior agent reply", timestamp: t2 }, false);
    let capturedSystem = "";
    let capturedNonSystem: { role: string; content: string }[] = [];
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        const nonSystem = messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : String(m.content) }));
        capturedSystem = system && typeof system.content === "string" ? system.content : "";
        capturedNonSystem = nonSystem;
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "current", () => {});
    // Recent thread is in the system message
    expect(capturedSystem).toContain("## Recent thread");
    expect(capturedSystem).toContain("prior user message");
    expect(capturedSystem).toContain("prior agent reply");
    // Only the current user message is a separate message
    expect(capturedNonSystem).toHaveLength(1);
    expect(capturedNonSystem[0].content).toBe("current");
    expect(capturedNonSystem[0].role).toBe("user");
  });

  it("respects contextRecentTurns setting as user rounds", async () => {
    updateSettings(ctx, { contextRecentTurns: 1 });
    const t0 = "2020-01-01T00:00:00.000Z";
    const t1 = "2020-01-01T00:00:01.000Z";
    const t2 = "2020-01-01T00:00:02.000Z";
    const t3 = "2020-01-01T00:00:03.000Z";
    appendEntry(ctx, sessionId, { role: "user", content: "oldest message", timestamp: t0 }, false);
    appendEntry(ctx, sessionId, { role: "agent", content: "oldest reply", timestamp: t1 }, false);
    appendEntry(ctx, sessionId, { role: "user", content: "recent message", timestamp: t2 }, false);
    appendEntry(ctx, sessionId, { role: "agent", content: "recent reply", timestamp: t3 }, false);
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent = system && typeof system.content === "string" ? system.content : "";
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "current", () => {});
    expect(systemContent).toContain("## Recent thread");
    expect(systemContent).toContain("recent message");
    expect(systemContent).toContain("recent reply");
    expect(systemContent).not.toContain("oldest message");
    expect(systemContent).not.toContain("oldest reply");
  });

  it("includes all entries from the last N user rounds, including tool calls between users", async () => {
    updateSettings(ctx, { contextRecentTurns: 2 });
    const t0 = "2020-01-01T00:00:00.000Z";
    const t1 = "2020-01-01T00:00:01.000Z";
    const t2 = "2020-01-01T00:00:02.000Z";
    const t3 = "2020-01-01T00:00:03.000Z";
    const t4 = "2020-01-01T00:00:04.000Z";
    const t5 = "2020-01-01T00:00:05.000Z";

    appendEntry(ctx, sessionId, { role: "user", content: "first user", timestamp: t0 }, false);
    appendEntry(ctx, sessionId, { role: "agent", content: "first reply", timestamp: t1 }, false);
    appendEntry(
      ctx,
      sessionId,
      {
        role: "tool_call",
        content: "tool result between users",
        toolName: "between_tool",
        toolArgs: { foo: "bar" },
        timestamp: t2,
      },
      false,
    );
    appendEntry(ctx, sessionId, { role: "agent", content: "follow-up reply", timestamp: t3 }, false);
    appendEntry(ctx, sessionId, { role: "user", content: "second user", timestamp: t4 }, false);
    appendEntry(ctx, sessionId, { role: "agent", content: "second reply", timestamp: t5 }, false);

    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent = system && typeof system.content === "string" ? system.content : "";
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };

    await runAgent(ctx, () => provider, "maia", sessionId, "current", () => {});

    expect(systemContent).toContain("## Recent thread");
    expect(systemContent).toContain("first user");
    expect(systemContent).toContain("first reply");
    expect(systemContent).toContain("**Tool (between_tool):**");
    expect(systemContent).toContain("tool result between users");
    expect(systemContent).toContain("second user");
    expect(systemContent).toContain("second reply");
  });

  it("includes entire history when there are fewer user rounds than contextRecentTurns", async () => {
    updateSettings(ctx, { contextRecentTurns: 5 });
    const t0 = "2020-01-01T00:00:00.000Z";
    const t1 = "2020-01-01T00:00:01.000Z";
    const t2 = "2020-01-01T00:00:02.000Z";
    const t3 = "2020-01-01T00:00:03.000Z";

    appendEntry(ctx, sessionId, { role: "user", content: "only user", timestamp: t0 }, false);
    appendEntry(ctx, sessionId, { role: "agent", content: "only reply", timestamp: t1 }, false);
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
    appendEntry(ctx, sessionId, { role: "agent", content: "follow-up after tool", timestamp: t3 }, false);

    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent = system && typeof system.content === "string" ? system.content : "";
        onToken("ok");
        return { content: "ok", toolCalls: [], stopped: true };
      },
    };

    await runAgent(ctx, () => provider, "maia", sessionId, "current", () => {});

    expect(systemContent).toContain("## Recent thread");
    expect(systemContent).toContain("only user");
    expect(systemContent).toContain("only reply");
    expect(systemContent).toContain("**Tool (single_tool):**");
    expect(systemContent).toContain("only tool");
    expect(systemContent).toContain("follow-up after tool");
  });

  it("puts recent thread section first in system message, then system prompt", async () => {
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent = system && typeof system.content === "string" ? system.content : "";
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "Hello", () => {});
    const recentPos = systemContent.indexOf("## Recent thread");
    const securityPos = systemContent.indexOf("SECURITY NOTICE");
    const identityPos = systemContent.indexOf("## Identity");
    expect(recentPos).toBeGreaterThanOrEqual(0);
    expect(securityPos).toBeGreaterThan(recentPos);
    expect(identityPos).toBeGreaterThan(securityPos);
  });

  it("shows no-turns message in recent thread section when session has no prior turns", async () => {
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        systemContent = system && typeof system.content === "string" ? system.content : "";
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "First message", () => {});
    expect(systemContent).toContain("## Recent thread");
    expect(systemContent).toContain("No recent turns");
  });

  it("includes recent thread block in system message when contextQueryModel is configured", async () => {
    updateSettings(ctx, { contextQueryModel: "ollama/llama3.2" });
    const capturedSystems: string[] = [];
    // A single provider handles all calls: query extraction, summarization, and main agent.
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const sys = messages.find((m) => m.role === "system");
        if (sys && typeof sys.content === "string") capturedSystems.push(sys.content);
        // Return JSON array for first call (query extraction), summary for second (summarization),
        // and a normal response for the main agent call.
        const idx = capturedSystems.length;
        const content =
          idx === 1 ? '["agent architecture"]' :
          idx === 2 ? "## Smart context\nSummary of context." :
          "Agent response";
        onToken(content);
        return { content, toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "Hello", () => {});
    // The main agent's system message (last captured) should contain the recent thread section
    const mainAgentSystem = capturedSystems[capturedSystems.length - 1] ?? "";
    expect(mainAgentSystem).toContain("## Recent thread");
  });

  it("includes the current system date and time section in the system prompt", async () => {
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        const content = system && typeof system.content === "string" ? system.content : "";
        if (content.includes("## Recent thread")) {
          systemContent = content;
        }
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };

    await runAgent(ctx, () => provider, "maia", sessionId, "Hello", () => {});

    expect(systemContent).toContain("## System date and time");
    expect(systemContent).toMatch(/Current system ISO datetime \(UTC\):\s*\d{4}-\d{2}-\d{2}T/);
    expect(systemContent).toContain("Current system local datetime:");
  });

  it("includes the running agent's own MD files (SOUL, MEMORY, USER) in the system prompt", async () => {
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
    expect(systemContent).toContain("The user is a developer.");
    expect(systemContent).toContain("## Identity");
    expect(systemContent).toContain("## Memory");
    expect(systemContent).toContain("## User");
    // Tool usage guidance: prefer web_answer, use web_search when needing links.
    expect(systemContent).toContain("Using web tools");
    expect(systemContent).toContain("web_answer");
    expect(systemContent).toContain("web_search");
  });

  it("does not include How you function section when AGENTS.md is absent (agent dir and project root)", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        const content = system && typeof system.content === "string" ? system.content : "";
        if (content.includes("## Recent thread"))
          systemContent = content;
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "Hello", () => {});
    expect(systemContent).not.toContain("## How you function");
    expect(systemContent).toContain("SECURITY NOTICE");
    expect(systemContent).toContain("## Identity");
    expect(systemContent).toContain("## Using your identity files");
  });

  it("when options.initialToolCall is set, executes that tool and sends result as first turn to the model", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    let firstRequestMessages: { role: string; content?: string; toolName?: string }[] = [];
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        if (firstRequestMessages.length === 0) firstRequestMessages = messages.map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : undefined,
          toolName: m.toolName,
        }));
        onToken("Acknowledged.");
        return { content: "Acknowledged.", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, makeProviderFactory(provider), "maia", sessionId, "[CRON] Run cron_echo", () => {}, {
      initialToolCall: { name: "cron_echo", args: { message: "scheduled payload" } },
    });
    expect(firstRequestMessages.some((m) => m.role === "user" && m.content?.includes("[CRON]"))).toBe(true);
    expect(firstRequestMessages.some((m) => m.role === "tool" && m.toolName === "cron_echo" && m.content === "scheduled payload")).toBe(true);
  });

  it("includes tool call arguments and results in the recent thread section", async () => {
    seedIdentityFiles(ctx.fs as FakeFs, "maia");
    const now = new Date().toISOString();
    appendEntry(ctx, sessionId, { role: "user", content: "Search for X", timestamp: now });
    appendEntry(ctx, sessionId, { role: "agent", content: "I'll search.", timestamp: now });
    appendEntry(ctx, sessionId, {
      role: "tool_call",
      content: "Found 3 results.",
      toolName: "knowledge",
      toolArgs: { query: "X", limit: 5 },
      timestamp: now,
    });
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        const content = system && typeof system.content === "string" ? system.content : "";
        if (content.includes("## Recent thread"))
          systemContent = content;
        onToken("Thanks");
        return { content: "Thanks", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, makeProviderFactory(provider), "maia", sessionId, "What did you find?", () => {});
    expect(systemContent).toContain("**Tool (knowledge):**");
    expect(systemContent).toContain("Arguments:");
    expect(systemContent).toContain('"query":"X"');
    expect(systemContent).toContain('"limit":5');
    expect(systemContent).toContain("Result:");
    expect(systemContent).toContain("Found 3 results.");
  });

  it("does not run smart context pipeline when options.enableSmartContext is false", async () => {
    updateSettings(ctx, { contextQueryModel: "ollama/llama3.2" });
    let completeCallCount = 0;
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        completeCallCount++;
        const content = "Reply";
        onToken(content);
        return { content, toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, makeProviderFactory(provider), "maia", sessionId, "Hello", () => {}, {
      enableSmartContext: false,
    });
    // Smart context would call complete for query extraction; with enableSmartContext: false we only get the main turn
    expect(completeCallCount).toBe(1);
  });

  it("runs smart context when options.enableSmartContext is true or omitted", async () => {
    updateSettings(ctx, { contextQueryModel: "ollama/llama3.2" });
    let completeCallCount = 0;
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        completeCallCount++;
        const content =
          completeCallCount === 1 ? '["query1"]' : "Reply";
        onToken(content);
        return { content, toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, makeProviderFactory(provider), "maia", sessionId, "Hello", () => {}, {
      enableSmartContext: true,
    });
    // Smart context uses a cheap model for query extraction, relevance filtering, and summarization,
    // plus the main agent call.
    expect(completeCallCount).toBeGreaterThanOrEqual(3);
  });

  it("appends smart_context tool_call history entry when smart context runs with sources", async () => {
    updateSettings(ctx, { contextQueryModel: "ollama/llama3.2" });
    const { createVectorStore } = await import("@/lib/knowledge/vector-store");
    const store = createVectorStore(ctx.db);
    store.insertHistory("hv1", sessionId, "entry-1", "past content about X", [0.9, 0.1], false, new Date().toISOString());
    store.upsertKnowledge("kv1", "docs/x.md", "doc content about X", "h1", [0.9, 0.1], new Date().toISOString());
    let callIndex = 0;
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        callIndex++;
        const system = messages.find((m) => m.role === "system");
        const sysContent = system && typeof system.content === "string" ? system.content : "";
        const isQuery = sysContent.includes("search query extraction");
        const isFilter = sysContent.includes("source relevance filtering");
        const isExtract = sysContent.includes("quote extraction");
        const content =
          isQuery ? '["X"]' :
          isFilter ? '["history:' + sessionId + '/entry-1", "knowledge:docs/x.md"]' :
          isExtract ? '[{"text": "past content about X"}]' :
          "Reply";
        onToken(content);
        return { content, toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, makeProviderFactory(provider), "maia", sessionId, "What do you know about X?", () => {});
    const rows = ctx.db.prepare("SELECT role, tool_name, content FROM history_entries WHERE session_id = ? ORDER BY timestamp ASC").all(sessionId) as Array<{ role: string; tool_name: string | null; content: string }>;
    const smartContextEntry = rows.find((r) => r.role === "tool_call" && r.tool_name === "smart_context");
    expect(smartContextEntry).toBeDefined();
    const payload = JSON.parse(smartContextEntry!.content) as { quotedSources?: unknown[]; additionalSources?: string[] };
    expect(payload.quotedSources).toBeDefined();
    expect(Array.isArray(payload.additionalSources)).toBe(true);
  });

  it("degrades gracefully when smart context retrieval fails (e.g. embeddings unavailable)", async () => {
    updateSettings(ctx, { contextQueryModel: "ollama/llama3.2" });
    // Replace http client so there is no /api/embed handler; embedding calls will fail.
    ctx.http = new FakeHttp();

    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        // Allow query-extraction call to succeed with a simple single-query array.
        const system = messages.find((m) => m.role === "system");
        const isQueryExtraction =
          system && typeof system.content === "string" && system.content.includes("search query extraction assistant");
        const content = isQueryExtraction ? '["query1"]' : "Reply";
        onToken(content);
        return { content, toolCalls: [], stopped: true };
      },
    };

    await expect(
      runAgent(ctx, makeProviderFactory(provider), "maia", sessionId, "Hello", () => {}),
    ).resolves.toBeDefined();
  });

  it("includes AGENTS.md from agent dir as full system command when present", async () => {
    const customInstruction = "Review GOALS every turn. Update MEMORY when you learn something important.";
    seedIdentityFiles(ctx.fs as FakeFs, "maia", { agentsMd: customInstruction });
    let systemContent = "";
    const provider: AIProvider = {
      async complete(messages, _tools, onToken) {
        const system = messages.find((m) => m.role === "system");
        const content = system && typeof system.content === "string" ? system.content : "";
        if (content.includes("## Recent thread") && content.includes("## Identity"))
          systemContent = content;
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "Hello", () => {});
    expect(systemContent).toContain(customInstruction);
    const recentPos = systemContent.indexOf("## Recent thread");
    const customPos = systemContent.indexOf(customInstruction);
    const identityPos = systemContent.indexOf("## Identity");
    expect(recentPos).toBeGreaterThanOrEqual(0);
    expect(customPos).toBeGreaterThan(recentPos);
    expect(identityPos).toBeGreaterThan(customPos);
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
        const content = system && typeof system.content === "string" ? system.content : "";
        if (content.includes("## Recent thread") && content.includes("## Identity"))
          systemContent = content;
        onToken("Hi");
        return { content: "Hi", toolCalls: [], stopped: true };
      },
    };
    await runAgent(ctx, () => provider, "maia", sessionId, "Hello", () => {});
    expect(systemContent).toContain(agentsContent);
    expect(systemContent).toContain("## Identity");
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
