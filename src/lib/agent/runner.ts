import path from "path";
import { getSettings } from "../settings";
import { getAgentIdentity, setAgentStatus } from "./identity";
import { getSession, appendEntry, ensureSession } from "../history";
import { getToolsForAgent } from "../tools/registry";
import { compressEntry } from "./compression";
import { indexHistoryEntry } from "../knowledge/history-index";
import { SECURITY_PREAMBLE } from "../security/preamble";
import { filterText } from "../security/injection-filter";
import type { AppContext } from "../context";
import type { AIProvider } from "../ai/types";
import type { HistoryEntry, SSEEvent } from "../types";
import type { Message } from "../ai/types";
import type { ToolContext } from "../tools/types";
import { getWorkspaceRoot } from "../data-dir";
import { getCurrentSystemDateTime } from "../date-time";

/**
 * @fileoverview Core agent runner loop, including history compression, system prompt construction, and tool execution.
 * @module lib/agent/runner
 */

export type SSECallback = (event: SSEEvent) => void;
export type ProviderFactory = (model: string, ctx: AppContext) => AIProvider;

/** Options for runAgent (e.g. emit history entries for background runs so the client receives them via EventSource). */
export interface RunAgentOptions {
  emitHistoryEntries?: boolean;
  /**
   * When set, the runner executes this tool first and feeds the result to the model as the first turn.
   * Used by cron jobs so each job invokes a specific tool (with args) instead of a free-form message.
   */
  initialToolCall?: { name: string; args: Record<string, unknown> };
}

const WORKSPACE_ROOT = getWorkspaceRoot();

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
    return await _runLoop(
      ctx,
      providerFactory,
      agent,
      sessionId,
      userMessage,
      onEvent,
      settings,
      options,
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

  const provider = providerFactory(agent.model, ctx);
  const tools = getToolsForAgent(agent.id);
  const toolDefs = tools.map((t) => t.toDefinition());

  const toolContext: ToolContext = {
    ...ctx,
    agentId: agent.id,
    sessionId,
    volumeRoot: path.join(WORKSPACE_ROOT, agent.id),
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
  indexHistoryEntry(ctx, userEntry.id).catch((err) =>
    console.error("History index (user entry) failed:", err),
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

  // Build context window: older entries use compressed when available, last recentFullCount use full (original).
  // Separate compressed from full so the model can tell the difference and know it can retrieve full context via tools.
  const session = getSession(ctx, sessionId);
  const original = session?.original ?? [];
  const compressed = session?.compressed ?? [];
  const recentFullCount = Math.max(1, settings.recentFullCount);
  const N = original.length;
  // Exclude current user message; when we have initialToolResult also exclude that tool entry from prior turns
  const priorCount = initialToolResult ? N - 2 : N - 1;
  const compressedSegment: { index: number; entry: HistoryEntry }[] = [];
  const fullSegment: { index: number; entry: HistoryEntry }[] = [];
  const compressedCutoff = Math.max(0, priorCount - recentFullCount);
  for (let i = 0; i < priorCount; i++) {
    const useCompressed =
      i < compressedCutoff && compressed[i] !== undefined;
    const entry = useCompressed ? compressed[i]! : original[i]!;
    if (entry.content.trim() === "") continue;
    if (useCompressed) {
      compressedSegment.push({ index: i, entry });
    } else {
      fullSegment.push({ index: i, entry });
    }
  }
  const conversationHistoryBlock = formatConversationHistorySections(
    compressedSegment,
    fullSegment,
  );
  const systemPromptContent = buildSystemPrompt(ctx, agent);
  const combinedSystemContent =
    conversationHistoryBlock + "\n\n---\n\n" + systemPromptContent;

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

  // Compression provider: try to create one, null means fallback to as-is
  let compressionProvider: AIProvider | null = null;
  try {
    compressionProvider = providerFactory(settings.compressionModel, ctx);
  } catch {
    /* model not whitelisted or not configured — compression disabled */
  }

  // Agentic loop
  let loopCount = 0;
  const MAX_LOOPS = 10;

  const DEBUG_SEP = "────────────────────────────────────────────────────────";
  const DEBUG_BLOCK = "════════════════════════════════════════════════════════";

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    /** @note Debug: we send exactly `messages` to the provider (one system, one user, then assistant/tool turns). Log summary + full payload so it's clear nothing is duplicated. */
    console.debug(`${DEBUG_BLOCK}\n  REQUEST START (loop ${loopCount})\n${DEBUG_BLOCK}`);
    const roles = messages.map((m) => m.role).join(", ");
    const lengths = messages.map((m) => (typeof m.content === "string" ? m.content.length : 0));
    console.debug(
      "[LLM request] Sending exactly this messages array (no duplication). Roles: [%s]. Content lengths: [%s]",
      roles,
      lengths.join(", "),
    );
    console.debug("[LLM request payload]", JSON.stringify({ messages }, null, 2));

    const response = await provider.complete(messages, toolDefs, (token) => {
      agentResponseContent += token;
      onEvent({ type: "token", content: token });
    });

    console.debug(`${DEBUG_SEP}\n  LLM RESPONSE\n${DEBUG_SEP}`);
    console.debug(
      "[LLM response]",
      JSON.stringify(
        {
          content: response.content,
          toolCalls: response.toolCalls,
          stopped: response.stopped,
        },
        null,
        2,
      ),
    );

    // If there are no tool calls, this is the final response
    if (response.toolCalls.length === 0) {
      agentEntry.content = response.content || agentResponseContent;
      agentEntry.timestamp = new Date().toISOString();
      const storedEntry = appendEntry(ctx, sessionId, agentEntry);
      emitEntryIfRequested(storedEntry);
      indexHistoryEntry(ctx, storedEntry.id).catch((err) =>
        console.error("History index (agent entry) failed:", err),
      );

      // Send "done" immediately so the stream closes and the UI never blocks. Run batch compression
      // in the background (fire-and-forget) so the agent never waits on compression.
      const finalContent = response.content || agentResponseContent;
      console.debug(`${DEBUG_SEP}\n  END OF TURN (done, no more tool calls)\n${DEBUG_BLOCK}\n`);
      onEvent({
        type: "done",
        sessionId,
        compressed: storedEntry,
        original: storedEntry,
      });
      runBackgroundCompression(
        ctx,
        sessionId,
        compressionProvider,
        settings.recentFullCount,
        settings.compressionBatchSize,
      );
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
    console.debug(
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
}

/**
 * Runs compression in the background for the next batch of entries that are outside the last recentFullCount.
 * Never blocks: called with void so the agent returns immediately.
 * @param ctx - App context
 * @param sessionId - Session id
 * @param compressionProvider - AI provider for compression, or null to store as-is
 * @param recentFullCount - Number of most recent entries to leave uncompressed
 * @param compressionBatchSize - Max entries to compress in this batch
 */
function runBackgroundCompression(
  ctx: AppContext,
  sessionId: string,
  compressionProvider: AIProvider | null,
  recentFullCount: number,
  compressionBatchSize: number,
): void {
  void (async () => {
    try {
      const session = getSession(ctx, sessionId);
      if (!session) return;
      const { original, compressed } = session;
      const toCompress = original.length - recentFullCount - compressed.length;
      if (toCompress < 1) return;
      const start = compressed.length;
      const end = Math.min(
        compressed.length + compressionBatchSize,
        original.length - recentFullCount,
      );
      const promises: Promise<HistoryEntry>[] = [];
      for (let i = start; i < end; i++) {
        const entry = original[i]!;
        if (entry.role === "user" || entry.role === "agent") {
          promises.push(compressEntry(ctx, compressionProvider, entry, sessionId));
        } else {
          // tool_call: store as-is with is_compressed=1 to keep 1:1 indices
          promises.push(Promise.resolve(appendEntry(ctx, sessionId, entry, true)));
        }
      }
      const results = await Promise.all(promises);
      for (const appended of results) {
        indexHistoryEntry(ctx, appended.id).catch((err) =>
          console.error("History index (compressed entry) failed:", err),
        );
      }
    } catch (err) {
      console.error("Background compression failed:", err);
    }
  })();
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
  "- For questions that can be answered from the web, prefer **brave_answers** to get an AI-generated answer grounded in current web search.",
  "- Use **web_search** when you specifically need raw links or you plan to open pages yourself using fetch_web_page or the browser tools.",
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

const COMPRESSED_RETRIEVAL_NOTE =
  "You can retrieve the full (uncompressed) content for any of the above turns using the history_get_session tool with mode: 'original'. Pass indexes (e.g. [0, 2, 5]) or rangeStart and rangeEnd (inclusive) to fetch multiple turns in one call.";

/**
 * Formats a single history entry for display (label + content, with tool args when present).
 * @param entry - History entry to format
 * @returns Formatted line (e.g. "**User:**\ncontent")
 */
function formatHistoryEntry(entry: HistoryEntry): string {
  const label =
    entry.role === "user"
      ? "**User:**"
      : entry.role === "agent"
        ? "**Assistant:**"
        : `**Tool (${entry.toolName ?? "unknown"}):**`;
  if (
    entry.role === "tool_call" &&
    entry.toolArgs != null &&
    Object.keys(entry.toolArgs).length > 0
  ) {
    return `${label}\nArguments: ${JSON.stringify(entry.toolArgs)}\nResult: ${entry.content}`;
  }
  return `${label}\n${entry.content}`;
}

/**
 * Formats prior session turns into a labeled text block for the system message, with compressed and full context clearly separated so the model knows which is which and that it can retrieve full context via tools using the turn index.
 * @brief Both sections include turn indices so the model can request any turn by index via history_get_session (mode: 'original'). Tool calls include both arguments and result.
 * @param compressedSegment - Older turns (compressed), with their session index for retrieval
 * @param fullSegment - Recent turns (full/original content), with session index for retrieval
 * @returns Section headings plus formatted lines; includes note about history_get_session for compressed turns
 */
function formatConversationHistorySections(
  compressedSegment: { index: number; entry: HistoryEntry }[],
  fullSegment: { index: number; entry: HistoryEntry }[],
): string {
  const top = "## Conversation history\n\n";
  if (compressedSegment.length === 0 && fullSegment.length === 0) {
    return top + "No prior messages in this session.";
  }
  const parts: string[] = [];
  if (compressedSegment.length > 0) {
    const compressedLines = compressedSegment.map(
      ({ index, entry }) => `[Turn ${index}]\n${formatHistoryEntry(entry)}`,
    );
    parts.push(
      "### Compressed context (older turns)\n\n" +
        "These are summaries only. " +
        COMPRESSED_RETRIEVAL_NOTE +
        "\n\n" +
        compressedLines.join("\n\n"),
    );
  }
  if (fullSegment.length > 0) {
    const fullLines = fullSegment.map(
      ({ index, entry }) => `[Turn ${index}]\n${formatHistoryEntry(entry)}`,
    );
    parts.push(
      "### Full context (recent turns)\n\n" +
        "Use history_get_session with mode: 'original' and the turn index above to retrieve full content. Pass indexes (e.g. [0, 2, 5]) or rangeStart/rangeEnd to fetch multiple turns in one call.\n\n" +
        fullLines.join("\n\n"),
    );
  }
  return top + parts.join("\n\n");
}
