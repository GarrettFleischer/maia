/**
 * @fileoverview Core agent runner loop: builds smart context via query extraction and semantic
 * search, assembles the system prompt with recent thread turns, and drives the agentic tool loop.
 * @module lib/agent/runner
 */

import path from "path";
import { getSettings } from "../settings";
import { getAgentIdentity, setAgentStatus } from "./identity";
import { getSession, appendEntry, ensureSession } from "../history";
import { getToolsForAgent } from "../tools/registry";
import { SECURITY_PREAMBLE } from "../security/preamble";
import { filterText } from "../security/injection-filter";
import {
  extractSearchQueries,
  buildRawRetrievedContext,
  filterRelevantSources,
  buildRawTextFromChunks,
  summarizeRetrievedContext,
  formatRecentThreadTurns,
} from "./context-query";
import type { AppContext } from "../context";
import type { CreateProviderOptions } from "../ai/factory";
import type { AIProvider } from "../ai/types";
import type { HistoryEntry, SSEEvent } from "../types";
import type { Message } from "../ai/types";
import type { ToolContext } from "../tools/types";
import { getWorkspaceRoot } from "../data-dir";
import { getCurrentSystemDateTime } from "../date-time";
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
  /**
   * When false, the smart context pipeline (query extraction + semantic search + summarization) is skipped.
   * Default true. Set false for heartbeat and other system-originated runs that already have inline context.
   */
  enableSmartContext?: boolean;
  /** Caller for queue priority when enqueueing smart context sub-jobs. */
  queueCaller?: QueueCaller;
  /**
   * When false, smart context steps (extractSearchQueries, buildRawRetrievedContext, etc.) run
   * inline instead of via the queue. Set when the agent is already running inside a queue job
   * (e.g. message_send) to avoid deadlock: the single worker would otherwise wait for itself.
   * Default true (use queue) for direct chat and other non-queue entry points.
   */
  smartContextViaQueue?: boolean;
}

const WORKSPACE_ROOT = getWorkspaceRoot();

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
  const toolDefs = tools.map((t) => t.toDefinition());

  const toolContext: ToolContext = {
    ...ctx,
    agentId: agent.id,
    sessionId,
    volumeRoot: path.join(WORKSPACE_ROOT, agent.id),
    providerFactory,
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

  // Build context: recent thread turns (always included) + optional smart context via semantic search.
  const session = getSession(ctx, sessionId);
  const sessionForContext = session ?? { original: [] as HistoryEntry[], compressed: [] as HistoryEntry[] };

  // Number of prior entries to expose (exclude the current user message just appended, and any initialToolResult entry)
  const priorEntriesCount = initialToolResult
    ? sessionForContext.original.length - 2
    : sessionForContext.original.length - 1;
  const priorEntries = sessionForContext.original.slice(0, Math.max(0, priorEntriesCount));
  const sessionForThread = { ...sessionForContext, original: priorEntries };

  const recentTurns = Math.max(1, settings.contextRecentTurns);
  const recentThreadBlock = formatRecentThreadTurns(sessionForThread as Parameters<typeof formatRecentThreadTurns>[0], recentTurns);

  // Smart context: extract queries → search history+knowledge → summarize with citations (only when enabled by call site)
  let smartContextBlock = "";
  const queryModel = settings.contextQueryModel;
  const smartContextAllowed = options?.enableSmartContext !== false;
  const smartContextEnabled = Boolean(
    smartContextAllowed && queryModel && settings.whitelistedModels.includes(queryModel),
  );
  agentDebug(
    "[Smart context]",
    smartContextEnabled
      ? `enabled (query model: ${queryModel})`
      : smartContextAllowed
        ? "disabled (no query model or not whitelisted)"
        : "disabled (call site set enableSmartContext: false)",
  );

  if (smartContextEnabled) {
    const queueCaller = options?.queueCaller ?? "agent";
    const useQueue = options?.smartContextViaQueue !== false;
    const contextProviderFactory = (model: string, ctx: AppContext) =>
      providerFactory(model, ctx, { reasoningEffort: settings.contextReasoningEffort });
    try {
      const queries = useQueue
        ? ((await enqueue(
            {
              tool: "extractSearchQueries",
              args: {
                userMessage,
                recentThreadBlock,
                providerFactory: contextProviderFactory,
              },
              caller: queueCaller,
            },
            () => ctx,
          )) as string[])
        : await extractSearchQueries(ctx, contextProviderFactory, userMessage, recentThreadBlock);
      agentDebug("[Smart context] extracted queries", { count: queries.length, queries });
      agentDebug("[Smart context] building raw context for", queries.length, "queries");
      const { text: rawContext, sources, contents } = useQueue
        ? ((await enqueue(
            {
              tool: "buildRawRetrievedContext",
              args: { queries },
              caller: queueCaller,
            },
            () => ctx,
          )) as Awaited<ReturnType<typeof buildRawRetrievedContext>>)
        : await buildRawRetrievedContext(ctx, queries);
      agentDebug("[Smart context] buildRawRetrievedContext done", {
        rawLength: rawContext.length,
        sourcesCount: sources.length,
      });
      agentDebug("[Smart context] retrieved context", {
        rawLength: rawContext.length,
        sourcesCount: sources.length,
        sourceIds: sources.map((s) => s.id),
      });
      agentDebug("[Smart context] sources found (before relevance filter)", sources);

      const allRetrievedSourceIds = sources.map((s) => s.id);
      let smartContextQuotes: Array<{ sourceId: string; text: string }> = [];

      if (sources.length === 0) {
        agentDebug("[Smart context] no retrieved sources; skipping relevance filter and summarizer");
        smartContextBlock = "## Smart context\n\nNo relevant prior context found.";
      } else {
        const { sources: filteredSources, contents: filteredContents } = useQueue
          ? ((await enqueue(
              {
                tool: "filterRelevantSources",
                args: {
                  userMessage,
                  sources,
                  contents,
                  providerFactory: contextProviderFactory,
                },
                caller: queueCaller,
              },
              () => ctx,
            )) as Awaited<ReturnType<typeof filterRelevantSources>>)
          : await filterRelevantSources(ctx, contextProviderFactory, userMessage, sources, contents);
        agentDebug("[Smart context] sources after relevance filter", {
          before: sources.length,
          after: filteredSources.length,
          keptIds: filteredSources.map((s) => s.id),
        });

        if (filteredSources.length === 0) {
          agentDebug("[Smart context] relevance filter kept no sources; skipping summarizer");
          smartContextBlock = "## Smart context\n\nNo relevant prior context found.";
        } else {
          const filteredRawContext = buildRawTextFromChunks(filteredSources, filteredContents);
          const summarizeResult = useQueue
            ? ((await enqueue(
                {
                  tool: "summarizeRetrievedContext",
                  args: {
                    rawText: filteredRawContext,
                    sources: filteredSources,
                    options: {
                      contents: filteredContents,
                      userMessage,
                      allRetrievedSourceIds,
                      retryOptions: undefined,
                    },
                    providerFactory: contextProviderFactory,
                  },
                  caller: queueCaller,
                },
                () => ctx,
              )) as Awaited<ReturnType<typeof summarizeRetrievedContext>>)
            : await summarizeRetrievedContext(ctx, contextProviderFactory, filteredRawContext, filteredSources, {
                contents: filteredContents,
                userMessage,
                allRetrievedSourceIds,
              });
          if (typeof summarizeResult === "string") {
            smartContextBlock = summarizeResult;
          } else {
            smartContextBlock = summarizeResult.block;
            smartContextQuotes = summarizeResult.quotes;
          }
          agentDebug("[Smart context] summary produced", {
            blockLength: smartContextBlock.length,
            quotesCount: smartContextQuotes.length,
          });
        }
      }

      const quotedSourceIds = [...new Set(smartContextQuotes.map((q) => q.sourceId))];
      const additionalSourceIds = allRetrievedSourceIds.filter((id) => !quotedSourceIds.includes(id));
      const quotedSourcesForHistory = quotedSourceIds.map((sourceId) => ({
        sourceId,
        snippets: smartContextQuotes.filter((q) => q.sourceId === sourceId).map((q) => q.text),
      }));
      appendEntry(ctx, sessionId, {
        role: "tool_call",
        content: JSON.stringify({ quotedSources: quotedSourcesForHistory, additionalSources: additionalSourceIds }),
        toolName: "smart_context",
        toolArgs: { queries },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      agentError("[Smart context] pipeline failed:", errMsg, errStack ?? "");
      // Surface smart context failures (for example, when the embedding service is unavailable)
      // so the agent run fails fast instead of silently skipping semantic context.
      throw err;
    }
  }

  const contextBlocks = [recentThreadBlock, smartContextBlock].filter(Boolean).join("\n\n");
  const systemPromptContent = buildSystemPrompt(ctx, agent);
  const combinedSystemContent = contextBlocks + "\n\n---\n\n" + systemPromptContent;

  const messages: Message[] = [
    { role: "system", content: combinedSystemContent },
    { role: "user", content: userMessage },
  ];
  if (initialToolResult) {
    messages.push({
      role: "tool",
      content: initialToolResult.content,
      toolCallId: "cron-initial",
      toolName: initialToolResult.toolName,
    });
  }

  let agentResponseContent = "";
  const agentEntry: Omit<HistoryEntry, "id"> = {
    role: "agent",
    content: "",
    timestamp: new Date().toISOString(),
  };

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

  const DEBUG_SEP = "────────────────────────────────────────────────────────";
  const DEBUG_BLOCK = "════════════════════════════════════════════════════════";
  /** Max chars to log per message so SYSTEM/CONTEXT/QUERY are readable with real line breaks. */
  const DEBUG_MESSAGE_MAX_LEN = 2000;

  try {
    while (loopCount < MAX_LOOPS) {
      loopCount++;

    /** @note Debug: log prompt with clear SYSTEM / CONTEXT / QUERY separation; content with real newlines. */
    agentDebug(`\n${DEBUG_BLOCK}\n  REQUEST START (loop ${loopCount})\n${DEBUG_BLOCK}`);
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
      const completeOptions = ollamaJobId ? { signal: controller.signal } : undefined;

      const response = await provider.complete(messages, toolDefs, (token) => {
        agentResponseContent += token;
        onEvent({ type: "token", content: token });
      }, completeOptions);

    agentDebug(`\n${DEBUG_SEP}\n  LLM RESPONSE\n${DEBUG_SEP}`);
    agentDebug("stopped:", response.stopped, "toolCalls:", response.toolCalls?.length ?? 0);
    if (response.content) {
      agentDebug("\n--- RESPONSE CONTENT ---\n" + response.content);
    }
    if (response.toolCalls?.length) {
      agentDebug("\n--- TOOL CALLS ---", JSON.stringify(response.toolCalls, null, 2));
    }

    // If there are no tool calls, this is the final response
    if (response.toolCalls.length === 0) {
      agentEntry.content = response.content || agentResponseContent;
      agentEntry.timestamp = new Date().toISOString();
      const storedEntry = appendEntry(ctx, sessionId, agentEntry);
      emitEntryIfRequested(storedEntry);
      scheduleHistoryIndex(ctx, storedEntry.id, options, (err) =>
        agentError("History index (agent entry) failed:", err),
      );

      // Send "done" immediately so the stream closes and the UI never blocks.
      const finalContent = response.content || agentResponseContent;
      agentDebug(`${DEBUG_SEP}\n  END OF TURN (done, no more tool calls)\n${DEBUG_BLOCK}\n`);
      onEvent({
        type: "done",
        sessionId,
        compressed: storedEntry,
        original: storedEntry,
      });
      return finalContent;
    }

    // Execute tool calls
    const toolResults: Message[] = [];
    for (const tc of response.toolCalls) {
      onEvent({ type: "tool_call", tool: tc.name, args: tc.args });

      const tool = tools.find((t) => t.name === tc.name);
      if (!tool) {
        const errorResult = `Unknown tool: ${tc.name}`;
        onEvent({
          type: "tool_result",
          tool: tc.name,
          result: { error: errorResult },
        });
        const contentStr = JSON.stringify({ error: errorResult });
        const toolEntry = {
          role: "tool_call" as const,
          content: contentStr,
          toolName: tc.name,
          toolArgs: tc.args,
          timestamp: new Date().toISOString(),
        };
        const storedToolEntry = appendEntry(ctx, sessionId, toolEntry);
        emitEntryIfRequested(storedToolEntry);
        toolResults.push({
          role: "tool",
          content: contentStr,
          toolCallId: tc.id,
          toolName: tc.name,
        });
        continue;
      }

      try {
        // Validate args with Zod
        const parsed = tool.schema.parse(tc.args);
        const result = await tool.execute(parsed, toolContext);

        // Filter result for injection (guard against undefined result)
        const resultStr =
          typeof result === "string" ? result : JSON.stringify(result ?? null);
        const filtered = filterText(resultStr ?? "", `tool:${tc.name}`);

        onEvent({ type: "tool_result", tool: tc.name, result: filtered.text });
        const storedToolResult = appendEntry(ctx, sessionId, {
          role: "tool_call",
          content: filtered.text,
          toolName: tc.name,
          toolArgs: tc.args,
          timestamp: new Date().toISOString(),
        });
        emitEntryIfRequested(storedToolResult);
        toolResults.push({
          role: "tool",
          content: filtered.text,
          toolCallId: tc.id,
          toolName: tc.name,
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        onEvent({
          type: "tool_result",
          tool: tc.name,
          result: { error: errorMsg },
        });
        const contentStr = JSON.stringify({ error: errorMsg });
        const storedToolError = appendEntry(ctx, sessionId, {
          role: "tool_call",
          content: contentStr,
          toolName: tc.name,
          toolArgs: tc.args,
          timestamp: new Date().toISOString(),
        });
        emitEntryIfRequested(storedToolError);
        toolResults.push({
          role: "tool",
          content: contentStr,
          toolCallId: tc.id,
          toolName: tc.name,
        });
      }
    }

    // Append assistant response + tool results to messages, loop again
    messages.push({
      role: "assistant",
      content: response.content || agentResponseContent,
    });
    messages.push(...toolResults);
    // Nudge models that tend to stop after one tool round: remind them they may call more tools.
    messages.push({
      role: "user",
      content:
        "[System reminder: If more steps are needed to complete the task, call tools again. Only reply with your final text when the task is complete.]",
    });
    agentResponseContent = "";
    agentDebug(
      `${DEBUG_SEP}\n  END OF TURN (tool calls applied; next request follows)\n${DEBUG_BLOCK}\n`,
    );
  }

  if (loopCount >= MAX_LOOPS) {
    onEvent({
      type: "error",
      message: "Agent reached maximum tool call loop limit",
    });
  }
  return "";
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
  "## Using your identity files",
  "Use your Memory and User sections above constantly. Keep them up to date using the agent_update_identity tool. Use the tasks tool for all task tracking (create, assign, update status).",
  "- **MEMORY**: When you learn something important (preferences, facts, context), update MEMORY.md.",
  "- **USER**: When you learn about the user (role, preferences, constraints), update USER.md.",
  "Update these files as often as relevant—do not wait for the user to ask. This keeps your context accurate across sessions.",
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
 * @brief Uses AGENTS.md (agent dir or project root) as the full system command, then appends Identity/Memory/Goals/User. If no file, uses fallback instructions.
 * @param ctx - App context (for reading project-root AGENTS.md fallback via ctx.fs)
 * @param agent - Loaded identity (soul, memory, user, agentsMd, optional systemPromptExtra)
 * @returns Single string system prompt
 */
function buildSystemPrompt(
  ctx: AppContext,
  agent: {
    soul: string;
    memory: string;
    user: string;
    agentsMd: string;
    systemPromptExtra?: string;
  },
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

  return [
    systemInstructions,
    "",
    systemTimeSectionLines.join("\n"),
    "",
    "## Identity",
    agent.soul,
    "",
    "## Memory",
    agent.memory,
    "",
    "## User",
    agent.user,
    agent.systemPromptExtra
      ? `\n## Additional Instructions\n${agent.systemPromptExtra}`
      : "",
  ]
    .filter((s) => s !== undefined)
    .join("\n");
}

