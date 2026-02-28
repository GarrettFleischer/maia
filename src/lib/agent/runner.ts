/**
 * @fileoverview Core agent runner loop: builds smart context via query extraction and semantic
 * search, assembles the system prompt with recent thread turns, and drives the agentic tool loop.
 * @module lib/agent/runner
 */

import path from "path";
import { getSettings } from "../settings";
import { getAgentIdentity, setAgentStatus } from "./identity";
import { getSession, appendEntry, ensureSession } from "../history";
import { getToolsForAgent, getMinimalToolDefsForAgent } from "../tools/registry";
import { SECURITY_PREAMBLE } from "../security/preamble";
import { filterText } from "../security/injection-filter";
import { transformContext, convertToLlm } from "./context-query";
import type { AppContext } from "../context";
import type { CreateProviderOptions } from "../ai/factory";
import type { AIProvider } from "../ai/types";
import type { AgentLoopEvent, HistoryEntry, SSEEvent } from "../types";
import type { Message } from "../ai/types";
import type { ToolContext } from "../tools/types";
import { getAgentDir } from "../data-dir";
import { getCurrentSystemDateTime } from "../date-time";
import { getMatchedSkillsContent } from "../skills";
import { completeOllamaJob, registerOllamaJob } from "../ollama/jobs";
import { enqueue } from "../queue/llm-queue";
import { runWithAgentContext, agentDebug, agentError } from "./agent-logger";

export type SSECallback = (event: SSEEvent) => void;
export type ProviderFactory = (model: string, ctx: AppContext, options?: CreateProviderOptions) => AIProvider;

/**
 * Canonical type for functions that run an agent with a message and return the reply.
 * @param ctx - Application context
 * @param agentId - ID of the agent to run
 * @param sessionId - Session to run in
 * @param message - User message to send
 * @param options - Optional run configuration
 * @returns The agent's final reply text, or empty string if no reply was produced
 */
export type RunAgentFn = (
  ctx: AppContext,
  agentId: string,
  sessionId: string,
  message: string,
  options?: RunAgentOptions,
) => Promise<string>;

import type { QueueCaller } from "../queue/llm-queue";

/** Options for runAgent (e.g. emit history entries for background runs so the client receives them via EventSource). */
export interface RunAgentOptions {
  emitHistoryEntries?: boolean;
  /**
   * When set, the runner executes this tool first and feeds the result to the model as the first turn.
   * Used by cron jobs so each job invokes a specific tool (with args) instead of a free-form message.
   */
  initialToolCall?: { name: string; args: Record<string, unknown> };
  /** Caller for queue priority when enqueueing background jobs (e.g. history index). */
  queueCaller?: QueueCaller;
  /**
   * When false, background steps (e.g. history indexing) run inline instead of via the queue.
   * Set when the agent is already running inside a queue job (e.g. message_send) to avoid deadlock.
   * Default true (use queue) for direct chat and other non-queue entry points.
   */
  smartContextViaQueue?: boolean;
}


/**
 * Schedules history indexing for one entry. When we're already inside a queue job (smartContextViaQueue false),
 * runs indexing in setImmediate so the single queue worker isn't blocked; otherwise enqueues.
 * @param ctx - Application context
 * @param entryId - History entry id to index
 * @param options - Run options (queueCaller, smartContextViaQueue)
 * @param onError - Called if indexing fails
 */
function scheduleHistoryIndex(
  ctx: AppContext,
  entryId: string,
  options: RunAgentOptions | undefined,
  onError: (err: unknown) => void,
): void {
  if (options?.smartContextViaQueue === false) {
    setImmediate(() => {
      import("../knowledge/history-index")
        .then(({ indexHistoryEntry }) => indexHistoryEntry(ctx, entryId))
        .catch(onError);
    });
    return;
  }
  enqueue(
    {
      tool: "indexHistoryEntry",
      args: { entryId },
      caller: options?.queueCaller ?? "agent",
    },
    () => ctx,
  ).catch(onError);
}

/**
 * Runs an agent in the given session with the given user message.
 * @returns The final assistant message content (reply text), or empty string if the agent hit max loops or produced no final message.
 */
export async function runAgent(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  agentId: string,
  sessionId: string,
  userMessage: string,
  onEvent: SSECallback,
  options?: RunAgentOptions,
): Promise<string> {
  const settings = getSettings(ctx);

  // Load agent
  const agent = getAgentIdentity(ctx, agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  if (!settings.whitelistedModels.includes(agent.model)) {
    throw new Error(`Model not whitelisted: ${agent.model}`);
  }

  setAgentStatus(ctx, agentId, "running");

  try {
    return await runWithAgentContext(
      { id: agent.id, name: agent.name },
      () =>
        _runLoop(
          ctx,
          providerFactory,
          agent,
          sessionId,
          userMessage,
          onEvent,
          settings,
          options,
        ),
    );
  } finally {
    setAgentStatus(ctx, agentId, "idle");
  }
}

/**
 * @returns The final assistant message content when the agent finishes, or empty string if max loops reached.
 */
async function _runLoop(
  ctx: AppContext,
  providerFactory: ProviderFactory,
  agent: NonNullable<Awaited<ReturnType<typeof getAgentIdentity>>>,
  sessionId: string,
  userMessage: string,
  onEvent: SSECallback,
  settings: ReturnType<typeof getSettings>,
  options?: RunAgentOptions,
): Promise<string> {
  const emitEntries = options?.emitHistoryEntries === true;

  function emitEntryIfRequested(entry: HistoryEntry): void {
    if (!emitEntries) return;
    const session = getSession(ctx, sessionId);
    if (session?.participants) {
      ctx.events.emit({
        event: "message",
        data: { sessionId, entry, participants: session.participants },
      });
    }
  }

  const provider = providerFactory(agent.model, ctx, { reasoningEffort: agent.reasoningEffort });
  const tools = getToolsForAgent(agent.id);
  const toolDefs = getMinimalToolDefsForAgent(agent.id);

  const toolContext: ToolContext = {
    ...ctx,
    agentId: agent.id,
    sessionId,
    volumeRoot: getAgentDir(agent.id),
    providerFactory,
    getToolsForAgent,
  };

  // Ensure session exists in this db (avoids FOREIGN KEY failure when session was created in another connection/process)
  ensureSession(ctx, sessionId, [agent.id], "agents");

  // Store user message (original)
  const userEntry = appendEntry(ctx, sessionId, {
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
  });
  emitEntryIfRequested(userEntry);
  scheduleHistoryIndex(ctx, userEntry.id, options, (err) =>
    agentError("History index (user entry) failed:", err),
  );

  // When cron (or similar) provides initialToolCall: execute the tool and append result so the model sees it as first turn.
  let initialToolResult: { toolName: string; content: string } | null = null;
  if (options?.initialToolCall) {
    const { name: toolName, args: toolArgs } = options.initialToolCall;
    const tool = tools.find((t) => t.name === toolName);
    if (tool) {
      try {
        const parsed = tool.schema.safeParse(toolArgs);
        if (parsed.success) {
          const result = await tool.execute(parsed.data, toolContext);
          const resultStr =
            typeof result === "string" ? result : JSON.stringify(result ?? null);
          const filtered = filterText(resultStr, `tool:${toolName}`);
          appendEntry(ctx, sessionId, {
            role: "tool_call",
            content: filtered.text,
            toolName,
            toolArgs,
            timestamp: new Date().toISOString(),
          });
          initialToolResult = { toolName, content: filtered.text };
        } else {
          const errMsg = parsed.error.message;
          const contentStr = JSON.stringify({ error: errMsg });
          appendEntry(ctx, sessionId, {
            role: "tool_call",
            content: contentStr,
            toolName,
            toolArgs,
            timestamp: new Date().toISOString(),
          });
          initialToolResult = { toolName, content: contentStr };
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const contentStr = JSON.stringify({ error: errMsg });
        appendEntry(ctx, sessionId, {
          role: "tool_call",
          content: contentStr,
          toolName,
          toolArgs,
          timestamp: new Date().toISOString(),
        });
        initialToolResult = { toolName, content: contentStr };
      }
    } else {
      const contentStr = JSON.stringify({ error: `Unknown tool: ${toolName}` });
      appendEntry(ctx, sessionId, {
        role: "tool_call",
        content: contentStr,
        toolName,
        toolArgs,
        timestamp: new Date().toISOString(),
      });
      initialToolResult = { toolName, content: contentStr };
    }
  }

  // No recent thread or smart context in the prompt; agents use chat_read, chat_find, and smart_context when needed.
  const recentThreadBlock = "";
  const smartContextBlock = "";

  const skillsContent = await getMatchedSkillsContent(ctx, agent.id, userMessage);
  const systemPromptContent = buildSystemPrompt(ctx, agent, skillsContent);
  const combinedSystemContent = transformContext(
    recentThreadBlock,
    smartContextBlock,
    systemPromptContent,
  );
  const messages: Message[] = convertToLlm(combinedSystemContent, userMessage, initialToolResult ?? undefined);

  let agentResponseContent = "";
  const agentEntry: Omit<HistoryEntry, "id"> = {
    role: "agent",
    content: "",
    timestamp: new Date().toISOString(),
  };

  /** When set, _runLoop returns this (final reply when no more tool calls). */
  const resultRef: { current: string | null } = { current: null };

  const DEBUG_SEP = "────────────────────────────────────────────────────────";
  const DEBUG_BLOCK = "════════════════════════════════════════════════════════";

  /**
   * Handles pi-style agent loop events: persistence (appendEntry, scheduleHistoryIndex) and SSE (onEvent).
   * @param event - AgentLoopEvent from the agentic loop
   */
  function handleAgentLoopEvent(event: AgentLoopEvent): void {
    switch (event.type) {
      case "agent_start":
        break;
      case "turn_start":
        agentDebug(`\n${DEBUG_BLOCK}\n  REQUEST START (loop ${event.loopIndex})\n${DEBUG_BLOCK}`);
        break;
      case "message_start":
        break;
      case "message_update":
        agentResponseContent += event.delta;
        onEvent({ type: "token", content: event.delta });
        break;
      case "message_end":
        if (event.toolCalls.length === 0) {
          const finalContent = event.content || agentResponseContent;
          agentEntry.content = finalContent;
          agentEntry.timestamp = new Date().toISOString();
          const storedEntry = appendEntry(ctx, sessionId, agentEntry);
          emitEntryIfRequested(storedEntry);
          scheduleHistoryIndex(ctx, storedEntry.id, options, (err) =>
            agentError("History index (agent entry) failed:", err),
          );
          agentDebug(`${DEBUG_SEP}\n  END OF TURN (done, no more tool calls)\n${DEBUG_BLOCK}\n`);
          onEvent({
            type: "done",
            sessionId,
            compressed: storedEntry,
            original: storedEntry,
          });
          resultRef.current = finalContent;
        }
        break;
      case "tool_execution_start":
        onEvent({ type: "tool_call", tool: event.toolName, args: event.args });
        break;
      case "tool_execution_end": {
        const storedToolEntry = appendEntry(ctx, sessionId, {
          role: "tool_call",
          content: event.content,
          toolName: event.toolName,
          toolArgs: event.toolArgs,
          timestamp: new Date().toISOString(),
        });
        emitEntryIfRequested(storedToolEntry);
        onEvent({
          type: "tool_result",
          tool: event.toolName,
          result: event.resultForSSE !== undefined ? event.resultForSSE : event.content,
        });
        break;
      }
      case "turn_end":
        agentDebug(
          `${DEBUG_SEP}\n  END OF TURN (tool calls applied; next request follows)\n${DEBUG_BLOCK}\n`,
        );
        break;
      case "agent_end":
        break;
      case "agent_error":
        onEvent({ type: "error", message: event.message });
        break;
    }
  }

  // Agentic loop
  let loopCount = 0;
  const MAX_LOOPS = 10;

  /** For Ollama agents: track current AbortController so cancel can abort the in-flight request. */
  const controllerRef: { current: AbortController | null } = { current: null };
  let ollamaJobId: string | null = null;
  if (agent.model.startsWith("ollama/")) {
    ollamaJobId = crypto.randomUUID();
    registerOllamaJob({
      id: ollamaJobId,
      model: agent.model,
      type: "chat",
      startedAt: new Date().toISOString(),
      status: "running",
      canStop: true,
      cancel: () => controllerRef.current?.abort(),
    });
  }

  /** Max chars to log per message so SYSTEM/CONTEXT/QUERY are readable with real line breaks. */
  const DEBUG_MESSAGE_MAX_LEN = 2000;

  try {
    handleAgentLoopEvent({ type: "agent_start" });

    while (loopCount < MAX_LOOPS && resultRef.current === null) {
      loopCount++;
      handleAgentLoopEvent({ type: "turn_start", loopIndex: loopCount });

    /** @note Debug: log prompt with clear SYSTEM / CONTEXT / QUERY separation; content with real newlines. */
    const roles = messages.map((m) => m.role).join(", ");
    const lengths = messages.map((m) => (typeof m.content === "string" ? m.content.length : 0));
    agentDebug("[LLM request] Roles: [%s]. Content lengths: [%s]", roles, lengths.join(", "));
    messages.forEach((m, i) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const label =
        m.role === "system"
          ? "SYSTEM (context + instructions)"
          : m.role === "user"
            ? "USER (query)"
            : String(m.role).toUpperCase();
      const truncated =
        content.length > DEBUG_MESSAGE_MAX_LEN
          ? content.slice(0, DEBUG_MESSAGE_MAX_LEN) +
            "\n\n... [truncated, total " +
            content.length +
            " chars]"
          : content;
      agentDebug("\n--- MESSAGE " + (i + 1) + ": " + label + " ---\n" + truncated);
    });

      const controller = new AbortController();
      controllerRef.current = controller;
      const completeOptions = {
        ...(ollamaJobId ? { signal: controller.signal } : {}),
        onThinkingToken: (delta: string) => onEvent({ type: "thinking", content: delta }),
      };

      handleAgentLoopEvent({ type: "message_start" });
      const response = await provider.complete(messages, toolDefs, (token) => {
        handleAgentLoopEvent({ type: "message_update", delta: token });
      }, completeOptions);

    agentDebug(`\n${DEBUG_SEP}\n  LLM RESPONSE\n${DEBUG_SEP}`);
    agentDebug("stopped:", response.stopped, "toolCalls:", response.toolCalls?.length ?? 0);
    if (response.content) {
      agentDebug("\n--- RESPONSE CONTENT ---\n" + response.content);
    }
    if (response.toolCalls?.length) {
      agentDebug("\n--- TOOL CALLS ---", JSON.stringify(response.toolCalls, null, 2));
    }

    // Emit message_end; handler persists and sets resultRef when no tool calls
    handleAgentLoopEvent({
      type: "message_end",
      content: response.content || agentResponseContent,
      toolCalls: response.toolCalls,
    });
    if (resultRef.current !== null) {
      return resultRef.current;
    }

    // Execute tool calls
    const toolResults: Message[] = [];
    for (const tc of response.toolCalls) {
      handleAgentLoopEvent({
        type: "tool_execution_start",
        toolCallId: tc.id,
        toolName: tc.name,
        args: tc.args,
      });

      const tool = tools.find((t) => t.name === tc.name);
      if (!tool) {
        const errorResult = `Unknown tool: ${tc.name}`;
        const contentStr = JSON.stringify({ error: errorResult });
        handleAgentLoopEvent({
          type: "tool_execution_end",
          toolCallId: tc.id,
          toolName: tc.name,
          content: contentStr,
          toolArgs: tc.args,
          resultForSSE: { error: errorResult },
        });
        toolResults.push({
          role: "tool",
          content: contentStr,
          toolCallId: tc.id,
          toolName: tc.name,
        });
        continue;
      }

      try {
        const parsed = tool.schema.parse(tc.args);
        const result = await tool.execute(parsed, toolContext);
        const resultStr =
          typeof result === "string" ? result : JSON.stringify(result ?? null);
        const filtered = filterText(resultStr ?? "", `tool:${tc.name}`);
        handleAgentLoopEvent({
          type: "tool_execution_end",
          toolCallId: tc.id,
          toolName: tc.name,
          content: filtered.text,
          toolArgs: tc.args,
        });
        toolResults.push({
          role: "tool",
          content: filtered.text,
          toolCallId: tc.id,
          toolName: tc.name,
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const contentStr = JSON.stringify({ error: errorMsg });
        handleAgentLoopEvent({
          type: "tool_execution_end",
          toolCallId: tc.id,
          toolName: tc.name,
          content: contentStr,
          toolArgs: tc.args,
          resultForSSE: { error: errorMsg },
        });
        toolResults.push({
          role: "tool",
          content: contentStr,
          toolCallId: tc.id,
          toolName: tc.name,
        });
      }
    }

    handleAgentLoopEvent({ type: "turn_end" });

    // Append assistant response + tool results to messages, loop again
    messages.push({
      role: "assistant",
      content: response.content || agentResponseContent,
    });
    messages.push(...toolResults);
    agentResponseContent = "";
  }

  if (loopCount >= MAX_LOOPS) {
    handleAgentLoopEvent({
      type: "agent_error",
      message: "Agent reached maximum tool call loop limit",
    });
  }
  return resultRef.current ?? "";
  } finally {
    if (ollamaJobId) completeOllamaJob(ollamaJobId);
  }
}


/**
 * Fallback system instruction when AGENTS.md is missing or empty.
 * @note Kept in code so the app still runs without the file; content should match AGENTS.md security + guidance sections.
 */
const FALLBACK_SYSTEM_INSTRUCTIONS = [
  SECURITY_PREAMBLE,
  "",
  "## Identity and context",
  "Your identity is in SOUL above. Memory and user facts live in the memory/ and user/ folders under your agent directory; use **knowledge_search** with scope (self, user, global) to retrieve them. Edit identity files (SOUL.md, AGENTS.md) and create fact files in memory/ and user/ via the **terminal** from your agent directory.",
  "",
  "## Using web tools",
  "- For questions that can be answered from the web, prefer **web_answer** to get an AI-generated answer grounded in current web search.",
  "- Use **web_search** when you specifically need raw links or you plan to open pages yourself using fetch_web_page or the browser tools (for example, when you need to inspect a specific page).",
  "- Avoid calling both tools for the same simple factual question unless you need to verify sources or inspect pages directly.",
].join("\n");

/**
 * Reads AGENTS.md from project root if present.
 * @brief Returns trimmed content or empty string when file is missing or unreadable.
 * @param ctx - App context (uses ctx.fs for reading)
 * @returns Contents of AGENTS.md or ""
 * @note Used by buildSystemPrompt when agent dir has no AGENTS.md.
 */
function readAgentsMd(ctx: AppContext): string {
  const agentsPath = path.join(process.cwd(), "AGENTS.md");
  try {
    const raw = ctx.fs.readFile(agentsPath);
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Builds the full system prompt for an agent run.
 * Order: agent ID → system date/time → AGENTS.md (attribution + content) → SOUL.md (attribution + content).
 * No Memory/User blocks; those live in memory/ and user/ and are retrieved via knowledge_search.
 * @param ctx - App context (for reading project-root AGENTS.md fallback via ctx.fs)
 * @param agent - Loaded identity (id, soul, agentsMd, optional systemPromptExtra)
 * @param skillsContent - Optional "## Active skills" block from getMatchedSkillsContent (empty string when none matched)
 * @returns Single string system prompt
 */
function buildSystemPrompt(
  ctx: AppContext,
  agent: {
    id: string;
    soul: string;
    agentsMd: string;
    systemPromptExtra?: string;
  },
  skillsContent?: string,
): string {
  const agentsContent =
    (agent.agentsMd && agent.agentsMd.trim())
      ? agent.agentsMd.trim()
      : readAgentsMd(ctx);

  const systemInstructions =
    agentsContent !== ""
      ? agentsContent
      : FALLBACK_SYSTEM_INSTRUCTIONS;

  const { iso, local, timezone } = getCurrentSystemDateTime();
  const systemTimeSectionLines = [
    "## System date and time",
    `Current system ISO datetime (UTC): ${iso}`,
    `Current system local datetime: ${local}`,
    `System timezone: ${timezone}`,
  ];

  const agentsAttribution = `The following instructions are from \`data/agents/${agent.id}/AGENTS.md\`.`;
  const soulAttribution = `The following is from \`data/agents/${agent.id}/SOUL.md\`.`;

  const parts: string[] = [
    `You are agent \`${agent.id}\`.`,
    "",
    systemTimeSectionLines.join("\n"),
    "",
    agentsAttribution,
    "",
    systemInstructions,
    "",
    soulAttribution,
    "",
    agent.soul,
  ];
  if (agent.systemPromptExtra) {
    parts.push("", "## Additional Instructions", agent.systemPromptExtra);
  }
  if (skillsContent && skillsContent.trim()) {
    parts.push("", skillsContent.trim());
  }
  return parts.join("\n");
}

