/**
 * @fileoverview Core agent runner loop: builds smart context via query extraction and semantic
 * search, assembles the system prompt with recent thread turns, and drives the agentic tool loop.
 * @module lib/agent/runner
 */

import path from "path";
import { getSettings } from "../settings";
import { getAgentIdentity, setAgentStatus } from "./identity";
import {
  getSession,
  appendEntry,
  ensureSession,
  entriesForConversation,
  updateSessionSmartContext,
} from "../history";
import {
  getToolsForAgent,
  getMinimalToolDefsForAgent,
} from "../tools/registry";
import { SECURITY_PREAMBLE } from "../security/preamble";
import { filterText } from "../security/injection-filter";
import {
  transformContext,
  convertToLlm,
  formatRecentThreadTurns,
  countUserRounds,
  buildSmartContextBlock,
  buildRecentRoundDetail,
  rewriteCommandWithContext,
  type PriorResolvedCommand,
} from "./context-query";
import type { AppContext } from "../context";
import type { CreateProviderOptions } from "../ai/factory";
import type { AIProvider } from "../ai/types";
import type {
  AgentLoopEvent,
  HistoryEntry,
  PersonaTurnOptions,
  SmartContextRun,
  SSEEvent,
} from "../types";
import type { Message } from "../ai/types";
import type { ToolContext } from "../tools/types";
import { getAgentDir, getAgentWorkspace } from "../data-dir";
import { getCurrentSystemDateTime } from "../date-time";
import { getMatchedSkillsContent } from "../skills";
import { completeOllamaJob, registerOllamaJob } from "../ollama/jobs";
import { enqueue } from "../queue/llm-queue";
import { runExclusive } from "../history/session-lock";
import { runWithAgentContext, agentDebug, agentError } from "./agent-logger";
import { buildPrepromptMemoryBlock } from "../memory/preprompt";

export type SSECallback = (event: SSEEvent) => void;
export type ProviderFactory = (
  model: string,
  ctx: AppContext,
  options?: CreateProviderOptions,
) => AIProvider;

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
  /**
   * Run as Maia with a delegated persona template (model + instructions). Requires `agentId === "maia"`.
   */
  personaTurn?: PersonaTurnOptions;
  /**
   * Overrides tool registry lookup (e.g. `persona:typescript-pro`). Derived from personaTurn when omitted.
   */
  toolAgentId?: string;
  /** Attribute the user row to Maia when Maia delegated a sub-task (persona run). */
  delegatedFromMaia?: boolean;
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
  return runExclusive(sessionId, () =>
    runAgentUnlocked(
      ctx,
      providerFactory,
      agentId,
      sessionId,
      userMessage,
      onEvent,
      options,
    ),
  );
}

async function runAgentUnlocked(
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

  if (options?.personaTurn) {
    if (agentId !== "maia") {
      throw new Error('personaTurn requires agentId "maia"');
    }
    if (!settings.whitelistedModels.includes(options.personaTurn.model)) {
      throw new Error(`Model not whitelisted: ${options.personaTurn.model}`);
    }
  } else if (!settings.whitelistedModels.includes(agent.model)) {
    throw new Error(`Model not whitelisted: ${agent.model}`);
  }

  const skipAgentStatus = options?.personaTurn !== undefined;
  if (!skipAgentStatus) {
    setAgentStatus(ctx, agentId, "running");
  }

  try {
    return await runWithAgentContext({ id: agent.id, name: agent.name }, () =>
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
    if (!skipAgentStatus) {
      setAgentStatus(ctx, agentId, "idle");
    }
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

  const effectiveToolAgentId =
    options?.toolAgentId ??
    (options?.personaTurn ? `persona:${options.personaTurn.id}` : agent.id);
  const runModel = options?.personaTurn?.model ?? agent.model;
  const runReasoning =
    options?.personaTurn?.reasoningEffort ?? agent.reasoningEffort;

  const provider = providerFactory(runModel, ctx, {
    reasoningEffort: runReasoning,
  });
  const tools = getToolsForAgent(effectiveToolAgentId);
  const toolDefs = getMinimalToolDefsForAgent(effectiveToolAgentId);

  const volumeRoot = options?.personaTurn
    ? getAgentDir("maia")
    : getAgentDir(agent.id);
  const defaultCwd = options?.personaTurn
    ? getAgentWorkspace("maia")
    : getAgentWorkspace(agent.id);

  const toolContext: ToolContext = {
    ...ctx,
    agentId: effectiveToolAgentId,
    sessionId,
    volumeRoot,
    defaultCwd,
    providerFactory,
    getToolsForAgent,
  };

  // Ensure session exists in this db (avoids FOREIGN KEY failure when session was created in another connection/process)
  ensureSession(ctx, sessionId, [agent.id], "agents");

  const contextProviderFactory = (model: string, c: AppContext) =>
    providerFactory(model, c, {
      reasoningEffort: settings.contextReasoningEffort,
    });

  // Compute prior context-aware commands and current round index, then rewrite the command.
  const existingSession = getSession(ctx, sessionId);
  let currentRoundIndex = existingSession
    ? countUserRounds(existingSession) + 1
    : 1;
  const priorCommands: PriorResolvedCommand[] = [];
  let conversationTopic: string | undefined;
  if (existingSession) {
    let seenUserRounds = 0;
    for (const entry of existingSession.original) {
      if (entry.role === "user") {
        seenUserRounds += 1;
        const roundIndex = entry.roundIndex ?? seenUserRounds;
        const resolvedCommand = entry.resolvedContent ?? entry.content;
        priorCommands.push({ roundIndex, resolvedCommand });
      }
    }
    // Derive a short discussion topic from the last agent message for clarified-command context.
    const lastAgent = [...existingSession.original]
      .reverse()
      .find((e) => e.role === "agent");
    if (lastAgent?.content) {
      const maxTopicLen = 200;
      conversationTopic =
        lastAgent.content.length <= maxTopicLen
          ? lastAgent.content.trim()
          : lastAgent.content.trim().slice(0, maxTopicLen).trim() + "…";
    }
  }

  const recentRoundDetail = existingSession
    ? buildRecentRoundDetail(existingSession)
    : "";
  const rewriteResult = await rewriteCommandWithContext(
    ctx,
    contextProviderFactory,
    priorCommands,
    currentRoundIndex,
    userMessage,
    { conversationTopic, recentRoundDetail: recentRoundDetail || undefined },
  );
  const effectiveUserMessage = rewriteResult.resolvedCommand;

  const AUTO_INCLUDE_ROUNDS = 3;
  const totalRoundsPrior = existingSession ? countUserRounds(existingSession) : 0;
  const roundsBeforePrior = Math.max(0, totalRoundsPrior - AUTO_INCLUDE_ROUNDS);
  const lastThreeBlockPrior =
    existingSession && existingSession.original.length > 0
      ? formatRecentThreadTurns(existingSession, AUTO_INCLUDE_ROUNDS, {
          skipThinking: true,
        })
      : "";
  const roundsNotePrior =
    roundsBeforePrior > 0
      ? `**Context:** You are seeing the last ${AUTO_INCLUDE_ROUNDS} conversation rounds below. There are **${roundsBeforePrior}** more rounds before these. Use **find_tool** to discover how to read earlier rounds when you need full context.\n\n`
      : "";
  const recentThreadBlock = lastThreeBlockPrior
    ? roundsNotePrior + lastThreeBlockPrior
    : "";

  // Store user message with resolved command and round index
  const userEntry = appendEntry(ctx, sessionId, {
    role: "user",
    content: userMessage,
    resolvedContent: effectiveUserMessage,
    roundIndex: currentRoundIndex,
    timestamp: new Date().toISOString(),
    ...(options?.delegatedFromMaia
      ? { speakerId: "maia", speakerLabel: "Maia" }
      : {}),
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
          const normalized =
            result === undefined || result === null
              ? { success: true }
              : result;
          const resultStr =
            typeof normalized === "string"
              ? normalized
              : JSON.stringify(normalized);
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

  // Clarified commands only (no full rounds) for query extraction; agent can use find_tool to discover how to read full context for rounds.
  const clarifiedCommandsBlock = [
    ...priorCommands.map((c) => `Round ${c.roundIndex}: ${c.resolvedCommand}`),
    `Round ${currentRoundIndex}: ${effectiveUserMessage}`,
  ].join("\n");
  // Ensure data and history embeddings are current before smart context retrieval.
  const { buildEmbeddings } = await import("../knowledge/rebuild-embeddings");
  await buildEmbeddings(ctx);
  const smartContextStart = Date.now();
  const sessionForIndex = getSession(ctx, sessionId);
  const conversationEntries = sessionForIndex
    ? entriesForConversation(sessionForIndex.original)
    : [];
  const smartContextAfterMessageIndex = Math.max(
    0,
    conversationEntries.length - 1,
  );
  const smartContextRunAccumulator: SmartContextRun = {
    phases: [],
    doneDetail: undefined,
  };
  /**
   * Persists the current smart context run to the session row so page refreshes
   * can restore all phase bubbles (queries, retrieval, filter, summary, done).
   * Single object updated in place per run.
   */
  function persistSmartContextRunPartial(): void {
    if (smartContextRunAccumulator.phases.length === 0) return;
    updateSessionSmartContext(
      ctx,
      sessionId,
      smartContextRunAccumulator,
      smartContextAfterMessageIndex,
    );
  }
  smartContextRunAccumulator.phases = [
    {
      phase: "clarified",
      detail: undefined,
      output: effectiveUserMessage,
    },
  ];
  onEvent({
    type: "smart_context_phase",
    phase: "clarified",
    output: effectiveUserMessage,
  });
  persistSmartContextRunPartial();
  const skillMatchAgentId = options?.personaTurn ? "maia" : agent.id;

  const prepromptMemory = await buildPrepromptMemoryBlock(
    ctx,
    effectiveToolAgentId,
    effectiveUserMessage,
    sessionId,
  );

  const [smartResult, skillsResult] = await Promise.all([
    buildSmartContextBlock(
      ctx,
      contextProviderFactory,
      effectiveUserMessage,
      clarifiedCommandsBlock,
      (phase, detail, output) => {
        onEvent({
          type: "smart_context_phase",
          phase,
          ...(detail !== undefined && { detail }),
          ...(output !== undefined && { output }),
        });
        if (phase === "queries") {
          const prev = smartContextRunAccumulator.phases;
          const last = prev[prev.length - 1];
          if (last?.phase === "queries") {
            // Same phase sent again (e.g. with output) - update in place so UI shows output
            smartContextRunAccumulator.phases[prev.length - 1] = {
              phase,
              detail,
              output,
            };
          } else {
            const hasClarified =
              smartContextRunAccumulator.phases[0]?.phase === "clarified";
            if (hasClarified) {
              smartContextRunAccumulator.phases.push({
                phase,
                detail,
                output,
              });
            } else {
              smartContextRunAccumulator.phases = [{ phase, detail, output }];
            }
          }
          smartContextRunAccumulator.doneDetail = undefined;
          persistSmartContextRunPartial();
        } else {
          const prev = smartContextRunAccumulator.phases;
          const last = prev[prev.length - 1];
          const isNewPhase = !last || last.phase !== phase;
          if (isNewPhase) {
            smartContextRunAccumulator.phases.push({ phase, detail, output });
          } else {
            smartContextRunAccumulator.phases[
              smartContextRunAccumulator.phases.length - 1
            ] = {
              phase,
              detail: detail ?? last.detail,
              output: output ?? last.output,
            };
          }
          if (phase === "done") {
            smartContextRunAccumulator.doneDetail = detail;
          }
          persistSmartContextRunPartial();
        }
      },
    ),
    getMatchedSkillsContent(ctx, skillMatchAgentId, effectiveUserMessage, {
      providerFactory: contextProviderFactory,
    }),
  ]);

  // Build the full prompt (system + user + optional tool) so we can include it in the done phase for the UI.
  const baseBlock =
    smartResult.block || "## Smart context\n\nNo relevant prior context found.";
  const sourcesSection =
    "\n\n### Sources\n" +
    (smartResult.sourceIds.length > 0
      ? smartResult.sourceIds.map((id) => `- ${id}`).join("\n")
      : "(none)");
  const skillsSection =
    "\n\n### Skills\n" +
    (skillsResult.skillNames.length > 0
      ? skillsResult.skillNames.map((n) => `- ${n}`).join("\n")
      : "(none)");
  const smartContextBlock =
    (prepromptMemory ? prepromptMemory + "\n\n" : "") +
    baseBlock +
    sourcesSection +
    skillsSection;

  const systemPromptContent = options?.personaTurn
    ? buildPersonaSystemPrompt(ctx, options.personaTurn, skillsResult.content)
    : buildSystemPrompt(ctx, agent, skillsResult.content);
  const combinedSystemContent = transformContext(
    recentThreadBlock,
    smartContextBlock,
    systemPromptContent,
  );
  const messages: Message[] = convertToLlm(
    combinedSystemContent,
    effectiveUserMessage,
    initialToolResult ?? undefined,
  );

  const fullPromptLines: string[] = [];
  for (const m of messages) {
    const role = m.role.toUpperCase();
    fullPromptLines.push(`--- ${role} ---`);
    fullPromptLines.push(m.content);
    fullPromptLines.push("");
  }
  const fullPrompt = fullPromptLines.join("\n").trimEnd();
  smartContextRunAccumulator.fullPrompt = fullPrompt;

  // Enhance the final done phase with active skills and full prompt so the UI and persisted run
  // show both included sources/skills and the exact prompt sent to the main LLM.
  const sourceCount = smartResult.sourceIds.length;
  const skillCount = skillsResult.skillNames.length;
  const combinedDoneDetail =
    skillCount > 0
      ? `${sourceCount} sources, ${skillCount} skills`
      : `${sourceCount} sources`;
  const sourceListRaw =
    sourceCount > 0 && smartResult.sourceLabels?.length === sourceCount
      ? smartResult.sourceLabels
      : sourceCount > 0
        ? smartResult.sourceIds
        : ["(no sources)"];
  const sourceListLines = sourceListRaw.map((line) =>
    typeof line === "string" && line.startsWith("- ") ? line : `- ${line}`,
  );
  const combinedDoneOutputLines: string[] = [
    `Included in context (${sourceCount} sources):`,
    ...sourceListLines,
    "",
    `Active skills (${skillCount}):`,
    ...(skillCount > 0
      ? skillsResult.skillNames.map((name) => `- ${name}`)
      : ["(none)"]),
  ];

  const toolsForAgent = getToolsForAgent(effectiveToolAgentId);
  const skillsContent = skillsResult.content;
  const toolsMentionedInSkills = toolsForAgent.filter((t) =>
    skillsContent.includes(t.name),
  );
  if (toolsMentionedInSkills.length > 0) {
    combinedDoneOutputLines.push("", "Relevant tools (from active skills):");
    combinedDoneOutputLines.push(
      ...toolsMentionedInSkills.map((t) => `- ${t.name}`),
    );
  }

  const combinedDoneOutput = combinedDoneOutputLines.join("\n");

  onEvent({
    type: "smart_context_phase",
    phase: "done",
    detail: combinedDoneDetail,
    output: combinedDoneOutput,
    fullPrompt,
  });

  // Keep SmartContextRun in sync with the enhanced done phase (overwrite the last
  // done phase when present so UI and persisted history see the same detail/output).
  {
    const prev = smartContextRunAccumulator.phases;
    const last = prev[prev.length - 1];
    const isNewPhase = !last || last.phase !== "done" || prev.length < 5;
    if (isNewPhase) {
      smartContextRunAccumulator.phases.push({
        phase: "done",
        detail: combinedDoneDetail,
        output: combinedDoneOutput,
      });
    } else {
      smartContextRunAccumulator.phases[prev.length - 1] = {
        phase: "done",
        detail: combinedDoneDetail,
        output: combinedDoneOutput,
      };
    }
    smartContextRunAccumulator.doneDetail = combinedDoneDetail;
  }

  if (
    smartContextRunAccumulator.phases.length > 0 &&
    smartContextRunAccumulator.doneDetail !== undefined
  ) {
    persistSmartContextRunPartial();
  }
  agentDebug(
    "[Smart context] runner: context + skills ready in",
    Date.now() - smartContextStart,
    "ms",
  );

  let agentResponseContent = "";
  const agentEntry: Omit<HistoryEntry, "id"> = {
    role: "agent",
    content: "",
    timestamp: new Date().toISOString(),
    ...(options?.personaTurn
      ? {
          speakerId: options.personaTurn.id,
          speakerLabel: options.personaTurn.name,
          personaId: options.personaTurn.id,
        }
      : {
          speakerId: agent.id,
          speakerLabel: agent.name,
        }),
  };

  /** When set, _runLoop returns this (final reply when no more tool calls). */
  const resultRef: { current: string | null } = { current: null };

  /** Accumulated thinking (reasoning) text for the current turn; persisted when we flush before token/tool/done. */
  const thinkingAccumulator = { current: "" };

  /**
   * Persists accumulated thinking to session history so it survives refresh/navigation.
   * Does not emit via EventSource to avoid duplicating the bubble already shown from the stream.
   * @returns The content that was flushed, or empty string if none (so the loop can include only the most recent thinking in the next request).
   */
  function flushThinking(): string {
    if (thinkingAccumulator.current.length === 0) return "";
    const content = thinkingAccumulator.current;
    thinkingAccumulator.current = "";
    appendEntry(ctx, sessionId, {
      role: "thinking",
      content,
      timestamp: new Date().toISOString(),
    });
    return content;
  }

  /** Most recent thinking flushed this turn; prepended to assistant message when appending to messages so the next request sees only one thinking bubble. */
  const lastFlushedThinkingRef = { current: "" };

  const DEBUG_SEP = "────────────────────────────────────────────────────────";
  const DEBUG_BLOCK =
    "════════════════════════════════════════════════════════";

  /**
   * Handles pi-style agent loop events: persistence (appendEntry, scheduleHistoryIndex) and SSE (onEvent).
   * @param event - AgentLoopEvent from the agentic loop
   */
  function handleAgentLoopEvent(event: AgentLoopEvent): void {
    switch (event.type) {
      case "agent_start":
        break;
      case "turn_start":
        agentDebug(
          `\n${DEBUG_BLOCK}\n  REQUEST START (loop ${event.loopIndex})\n${DEBUG_BLOCK}`,
        );
        break;
      case "message_start":
        break;
      case "message_update":
        agentResponseContent += event.delta;
        onEvent({ type: "token", content: event.delta });
        break;
      case "message_end": {
        const flushed = flushThinking();
        if (flushed) lastFlushedThinkingRef.current = flushed;
        if (event.toolCalls.length === 0) {
          const finalContent = event.content || agentResponseContent;
          agentEntry.content = finalContent;
          agentEntry.timestamp = new Date().toISOString();
          const storedEntry = appendEntry(ctx, sessionId, agentEntry);
          emitEntryIfRequested(storedEntry);
          scheduleHistoryIndex(ctx, storedEntry.id, options, (err) =>
            agentError("History index (agent entry) failed:", err),
          );
          agentDebug(
            `${DEBUG_SEP}\n  END OF TURN (done, no more tool calls)\n${DEBUG_BLOCK}\n`,
          );
          onEvent({
            type: "done",
            sessionId,
            compressed: storedEntry,
            original: storedEntry,
          });
          resultRef.current = finalContent;
        }
        break;
      }
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
          result:
            event.resultForSSE !== undefined
              ? event.resultForSSE
              : event.content,
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

  // Agentic loop (no hard limit; runs until agent returns a final response)
  let loopCount = 0;

  /** For Ollama agents: track current AbortController so cancel can abort the in-flight request. */
  const controllerRef: { current: AbortController | null } = { current: null };
  let ollamaJobId: string | null = null;
  if (runModel.startsWith("ollama/")) {
    ollamaJobId = crypto.randomUUID();
    registerOllamaJob({
      id: ollamaJobId,
      model: runModel,
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

    while (resultRef.current === null) {
      loopCount++;
      handleAgentLoopEvent({ type: "turn_start", loopIndex: loopCount });

      /** @note Debug: log prompt with clear SYSTEM / CONTEXT / QUERY separation; content with real newlines. */
      const roles = messages.map((m) => m.role).join(", ");
      const lengths = messages.map((m) =>
        typeof m.content === "string" ? m.content.length : 0,
      );
      agentDebug(
        "[LLM request] Roles: [%s]. Content lengths: [%s]",
        roles,
        lengths.join(", "),
      );
      messages.forEach((m, i) => {
        const content =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content);
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
        agentDebug(
          "\n--- MESSAGE " + (i + 1) + ": " + label + " ---\n" + truncated,
        );
      });

      const controller = new AbortController();
      controllerRef.current = controller;
      const completeOptions = {
        ...(ollamaJobId ? { signal: controller.signal } : {}),
        onThinkingToken: (delta: string) => {
          thinkingAccumulator.current += delta;
          onEvent({ type: "thinking", content: delta });
        },
      };

      handleAgentLoopEvent({ type: "message_start" });
      const response = await provider.complete(
        messages,
        toolDefs,
        (token) => {
          const flushed = flushThinking();
          if (flushed) lastFlushedThinkingRef.current = flushed;
          handleAgentLoopEvent({ type: "message_update", delta: token });
        },
        completeOptions,
      );

      agentDebug(`\n${DEBUG_SEP}\n  LLM RESPONSE\n${DEBUG_SEP}`);
      agentDebug(
        "stopped:",
        response.stopped,
        "toolCalls:",
        response.toolCalls?.length ?? 0,
      );
      if (response.content) {
        agentDebug("\n--- RESPONSE CONTENT ---\n" + response.content);
      }
      if (response.toolCalls?.length) {
        agentDebug(
          "\n--- TOOL CALLS ---",
          JSON.stringify(response.toolCalls, null, 2),
        );
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
          const normalized =
            result === undefined || result === null
              ? { success: true }
              : result;
          const resultStr =
            typeof normalized === "string"
              ? normalized
              : JSON.stringify(normalized);
          const filtered = filterText(resultStr, `tool:${tc.name}`);
          handleAgentLoopEvent({
            type: "tool_execution_end",
            toolCallId: tc.id,
            toolName: tc.name,
            content: filtered.text,
            toolArgs: tc.args,
            resultForSSE:
              typeof normalized === "string" ? normalized : normalized,
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

      // Append assistant response + tool results to messages, loop again.
      // Include only the most recent thinking bubble (this turn's) so context window is not filled by reasoning.
      const assistantContent = response.content || agentResponseContent;
      const withReasoning =
        lastFlushedThinkingRef.current.length > 0
          ? `Reasoning: ${lastFlushedThinkingRef.current}\n\n${assistantContent}`
          : assistantContent;
      messages.push({ role: "assistant", content: withReasoning });
      lastFlushedThinkingRef.current = "";
      messages.push(...toolResults);
      agentResponseContent = "";
    }

    return resultRef.current ?? "";
  } finally {
    if (ollamaJobId) completeOllamaJob(ollamaJobId);
  }
}

/**
 * Fallback system instruction when agent `PERSONA.md` and project-root `PERSONA.md` are both missing or empty.
 * @note Kept in code so the app still runs without files on disk.
 */
const FALLBACK_SYSTEM_INSTRUCTIONS = [
  "## Identity and context",
  "Your persona markdown (`PERSONA.md`) was missing or empty; follow the security preamble above and skills until an operator fills it in. Memory and user facts live in the memory/ and user/ folders next to `PERSONA.md`, above workspace (`~`). Use **knowledge_search** with scope (self, user, global) when needed.",
  "",
  "## Skills and behavior",
  "Operational behavior is defined in skills that may appear in a `## Active skills` section. Follow those skills alongside this notice.",
].join("\n");

/**
 * @brief Reads optional project-root persona fallback (`PERSONA.md`).
 * @param ctx - App context (uses ctx.fs for reading)
 * @returns Trimmed markdown or ""
 */
function readProjectPersonaMd(ctx: AppContext): string {
  const personaPath = path.join(process.cwd(), "PERSONA.md");
  try {
    const raw = ctx.fs.readFile(personaPath);
    return typeof raw === "string" ? raw.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Builds the system prompt for a delegated persona run (Maia + template instructions).
 * @param ctx - App context
 * @param persona - Persona id, display name, instructions, and model (model not repeated here)
 * @param skillsContent - Optional "## Active skills" block from getMatchedSkillsContent
 * @returns Single string system prompt
 */
function buildPersonaSystemPrompt(
  _ctx: AppContext,
  persona: PersonaTurnOptions,
  skillsContent?: string,
): string {
  const { iso, local, timezone } = getCurrentSystemDateTime();
  const systemTimeSectionLines = [
    "## System date and time",
    `Current system ISO datetime (UTC): ${iso}`,
    `Current system local datetime: ${local}`,
    `System timezone: ${timezone}`,
  ];
  const parts: string[] = [
    SECURITY_PREAMBLE,
    "",
    `You are the persona **${persona.name}** (id: \`${persona.id}\`). You run inside Maia with workspace \`data/agents/maia/workspace\`. Use **smart_context**, **find_tool**, and **find_skill** as needed. Report progress to the user.`,
    "",
    systemTimeSectionLines.join("\n"),
    "",
    "## Persona instructions (template)",
    "",
    persona.instructions.trim(),
  ];
  if (skillsContent && skillsContent.trim()) {
    parts.push("", skillsContent.trim());
  }
  return parts.join("\n");
}

/**
 * Builds the full system prompt for an agent run.
 * Order: security preamble → agent ID → system date/time → persona markdown (`PERSONA.md`) with attribution.
 * memory/ and user/ facts stay on disk; retrieve via knowledge_search and layered-memory tools.
 * @param ctx - App context (project-root PERSONA.md fallback via ctx.fs when agent persona empty)
 * @param agent - Loaded identity (id, persona markdown, optional systemPromptExtra)
 * @param skillsContent - Optional "## Active skills" block from getMatchedSkillsContent (empty string when none matched)
 * @returns Single string system prompt
 */
function buildSystemPrompt(
  ctx: AppContext,
  agent: {
    id: string;
    persona: string;
    systemPromptExtra?: string;
  },
  skillsContent?: string,
): string {
  const trimmedAgentPersona = agent.persona.trim();
  const trimmedRootPersona = readProjectPersonaMd(ctx).trim();
  const personaBody =
    trimmedAgentPersona !== "" ? trimmedAgentPersona : trimmedRootPersona;

  const systemInstructions =
    personaBody !== "" ? personaBody : FALLBACK_SYSTEM_INSTRUCTIONS;

  let personaAttribution: string;
  if (trimmedAgentPersona !== "") {
    personaAttribution = `The following persona text is from \`data/agents/${agent.id}/PERSONA.md\`.`;
  } else if (trimmedRootPersona !== "") {
    personaAttribution =
      "The following persona text is from project-root `PERSONA.md` (agent PERSONA.md was empty).";
  } else {
    personaAttribution =
      "Persona markdown was missing; using compiled fallback instructions below.";
  }

  const { iso, local, timezone } = getCurrentSystemDateTime();
  const systemTimeSectionLines = [
    "## System date and time",
    `Current system ISO datetime (UTC): ${iso}`,
    `Current system local datetime: ${local}`,
    `System timezone: ${timezone}`,
  ];

  const parts: string[] = [
    SECURITY_PREAMBLE,
    "",
    `You are agent \`${agent.id}\`.`,
    "",
    systemTimeSectionLines.join("\n"),
    "",
    personaAttribution,
    "",
    systemInstructions,
  ];
  if (agent.systemPromptExtra) {
    parts.push("", "## Additional Instructions", agent.systemPromptExtra);
  }
  if (skillsContent && skillsContent.trim()) {
    parts.push("", skillsContent.trim());
  }
  return parts.join("\n");
}
