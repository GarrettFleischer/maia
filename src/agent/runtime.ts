/**
 * @fileoverview Core agent runtime loop. Orchestrates message processing:
 * receives inbound messages, builds context, calls LLM, handles tool calls,
 * and sends responses back through channels.
 * @module agent/runtime
 *
 * @note The runtime ties together all subsystems: session management,
 * context building, memory recall, tool execution, privacy, and threading.
 */

import type {
  ChatMessage,
  ChatOptions,
  EventBus,
  InboundMessage,
  LLMProvider,
  Logger,
  MaiaConfig,
  OutboundMessage,
} from "../core/types.js";
import { redactSecretsFromResponse } from "../security/content-sanitizer.js";
import type { ContextBuilder, ContextInput } from "./context.js";
import type { SessionManager } from "./session.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { MergeStrategy } from "../memory/periodic-merge.js";

import type { RememberedContent } from "../memory/remember-block.js";
import { REMEMBER_DELIMITER } from "../memory/remember-block.js";
import { parseResponseBlocks } from "./response-blocks.js";

/**
 * @brief Kind of a single chat log message (for persistence and UI).
 */
export type ChatLogMessageKind = "user" | "assistant" | "tool_call" | "tool_result" | "agent_dm";

/**
 * @brief A single entry in the chat log for this turn (assistant text, tool call, or tool result).
 */
export interface ChatLogMessage {
  kind: ChatLogMessageKind;
  /** Display content (for assistant/agent_dm) or tool result text (for tool_result). */
  content: string;
  /** Tool name (for tool_call and tool_result). */
  toolName?: string;
  /** Tool args (for tool_call only). */
  toolArgs?: Record<string, unknown>;
  /** Human-readable summary (for tool_call/tool_result UI). */
  toolSummary?: string;
  /** Whether the tool succeeded (for tool_result). */
  toolSuccess?: boolean;
}

/**
 * @brief Result of handling a message: display content and optional remembered/security/progress for UI and backend.
 */
export interface HandleMessageResult {
  /** Assistant reply text to show to the user (final content). */
  content: string;
  /** When the LLM included a remember block and it was applied; content per file for hover tooltip. */
  remembered?: RememberedContent;
  /** Human-readable tool call entries (name, summary, success, optional detail) for chat UI; shown as expandable list. */
  toolCallsSummary?: Array<{ name: string; summary: string; success: boolean; detail?: string }>;
  /** Chat log entries for this turn (assistant messages, tool_call, tool_result) for persistence and UI. */
  messages?: ChatLogMessage[];
  /** When the LLM reported a security concern (inline); backend should check approved snippets then stop/notify if needed. */
  securityFlagged?: { reason: string; snippet: string };
  /** When the LLM self-reported progress (accomplished/stuck/failed); backend may send DM. */
  progressReport?: { status: string; summary: string };
}

/**
 * @brief Builds a short human-readable summary for a tool call (for chat UI).
 * @param name - Tool name (e.g. agent_create, web_fetch)
 * @param args - Tool arguments
 * @returns One-line summary (e.g. "Created agent wally")
 */
function formatToolCallSummary(
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case "agent_create": {
      const id = typeof args.id === "string" ? args.id : undefined;
      return id ? `Created agent ${id}` : "Created an agent";
    }
    case "agent_list":
      return "Listed agents";
    case "agent_remove": {
      const id = typeof args.id === "string" ? args.id : undefined;
      return id ? `Removed agent ${id}` : "Removed an agent";
    }
    case "message": {
      const to = typeof args.recipientId === "string" ? args.recipientId : undefined;
      return to ? `Sent message to ${to}` : "Sent a message";
    }
    case "agent_inspect":
      return "Inspected an agent";
    case "agent_update":
      return "Updated an agent";
    case "web_fetch":
      return "Fetched a URL";
    case "remember":
      return "Saved something to memory";
    case "memory_search":
      return "Searched memory";
    case "memory_store":
      return "Stored in memory";
    case "memory_forget":
      return "Forgot a memory";
    case "task_manage":
      return "Updated task list";
    case "task_assign": {
      const id = typeof args.agentId === "string" ? args.agentId : undefined;
      return id ? `Assigned task to ${id}` : "Assigned task to agent";
    }
    case "submit_widget_for_review":
      return "Submitted a widget for review";
    case "widget_create_or_edit": {
      const widgetId = typeof args.widgetId === "string" ? args.widgetId : undefined;
      return widgetId ? `Created/updated widget ${widgetId}` : "Created/updated a widget";
    }
    case "widget_delete": {
      const widgetId = typeof args.widgetId === "string" ? args.widgetId : undefined;
      return widgetId ? `Deleted widget ${widgetId}` : "Deleted a widget";
    }
    case "agent_shutdown":
      return "Shut down";
    case "file_read":
      return "Read a file";
    case "file_write":
      return "Wrote a file";
    case "file_list":
      return "Listed directory";
    default:
      return `Used ${name}`;
  }
}

/**
 * @brief Returns true if content looks like raw tool-call JSON (to strip from display).
 */
function isRawToolCallContent(content: string): boolean {
  const t = content.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return false;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    return typeof o.tool === "string" && "arguments" in o;
  } catch {
    return false;
  }
}

/**
 * @brief Finds the index of the matching closing brace for an object starting at startIndex.
 * Respects strings (so braces inside quoted strings are ignored).
 * @param content - Full string
 * @param startIndex - Index of the opening {
 * @returns Index of the closing }, or -1 if not found
 */
function findMatchingBrace(content: string, startIndex: number): number {
  if (content[startIndex] !== "{") return -1;
  let depth = 1;
  let inString = false;
  let escape = false;
  let quoteChar = "\0";
  for (let i = startIndex + 1; i < content.length; i++) {
    const c = content[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === quoteChar) {
        inString = false;
        continue;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quoteChar = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * @brief Removes any embedded raw tool-call JSON from content (e.g. inside <p> or markdown).
 * Repeatedly finds { "tool": "...", "arguments": ... } objects and removes them so they are never shown to the user.
 */
function stripRawToolCallJson(content: string): string {
  let out = content;
  let searchStart = 0;
  for (;;) {
    const idx = out.indexOf("{", searchStart);
    if (idx === -1) break;
    const end = findMatchingBrace(out, idx);
    if (end === -1) {
      searchStart = idx + 1;
      continue;
    }
    const slice = out.slice(idx, end + 1);
    try {
      const o = JSON.parse(slice) as Record<string, unknown>;
      if (typeof o.tool === "string" && "arguments" in o) {
        out = out.slice(0, idx).trimEnd() + " " + out.slice(end + 1).trimStart();
        out = out.trim();
        searchStart = 0;
        continue;
      }
    } catch {
      // not valid JSON or not tool-call shape
    }
    searchStart = idx + 1;
  }
  return out.trim();
}

/**
 * @brief New structured JSON response shape: optional chat_message + at most one tool per turn.
 */
export interface NewStructuredResponse {
  chat_message: string;
  tool: { name: string; args: Record<string, unknown> } | null;
}

/**
 * @brief Tries to parse response content as structured JSON (chat_message + optional single tool).
 * Strips markdown code fences (```json ... ```) if present.
 * @returns Parsed result or null if not valid structured response
 */
function parseNewStructuredResponse(content: string): NewStructuredResponse | null {
  let t = content.trim();
  if (t.startsWith("```")) {
    const afterOpen = t.indexOf("\n", 3);
    const close = t.indexOf("```", afterOpen > 0 ? afterOpen : 3);
    if (close !== -1) {
      t = (afterOpen > 0 ? t.slice(afterOpen + 1, close) : t.slice(3, close)).trim();
    }
  }
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    // chat_message: string | null | undefined -> normalize to string (empty string if absent)
    const rawChat = o.chat_message;
    const chat_message =
      rawChat === null || rawChat === undefined
        ? ""
        : typeof rawChat === "string"
          ? rawChat
          : "";
    // tool: { name, args } | null | undefined -> at most one tool per turn
    let tool: { name: string; args: Record<string, unknown> } | null = null;
    const rawTool = o.tool;
    if (rawTool && typeof rawTool === "object" && typeof (rawTool as Record<string, unknown>).name === "string") {
      const name = (rawTool as Record<string, unknown>).name as string;
      const rawArgs = (rawTool as Record<string, unknown>).args ?? (rawTool as Record<string, unknown>).arguments;
      const args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      tool = { name, args };
    }
    return { chat_message, tool };
  } catch {
    return null;
  }
}

/**
 * @brief Parses optional ---REMEMBER--- block from LLM response and appends to workspace files.
 * When present, runtime uses returned displayContent for reply and passes rememberedContent to result.
 */
export type ParseRememberFn = (
  rawContent: string,
) => Promise<{
  displayContent: string;
  remembered: boolean;
  rememberedContent?: RememberedContent;
}>;

/**
 * @brief Dependencies for createAgentRuntime.
 */
export interface AgentRuntimeDeps {
  config: MaiaConfig;
  logger: Logger;
  events: EventBus;
  provider: LLMProvider;
  sessionManager: SessionManager;
  contextBuilder: ContextBuilder;
  toolRegistry: ToolRegistry;
  /** Returns relevant memory context for the query (from auto-recall) */
  recallMemory?: (query: string) => Promise<string>;
  /** Returns the current thread summary for a session */
  getThreadSummary?: (sessionId: string) => string | undefined;
  /** Checks if privacy mode is active for a session */
  isPrivacyActive?: (sessionId: string) => boolean;
  /** Sends a message back to the originating channel */
  sendReply: (message: OutboundMessage) => Promise<void>;
  /**
   * @brief When set, the runtime may run a combined reply+memory merge instead of
   * normal chat when shouldRunMerge() is true (e.g. every 10 min). Merge path does
   * not call onAfterReply (merge appends to daily log itself).
   */
  mergeStrategy?: MergeStrategy;
  /**
   * @brief Called after each reply is sent. Used for post-reply persistence
   * (daily log append). Not called when the merge path was used.
   * Runs fire-and-forget so it never blocks the user's reply.
   * @param params - User content, response content, session ID, and privacy flag
   */
  /**
   * @brief When set, parses ---REMEMBER--- from the LLM response and appends to MEMORY/USER/SOUL.
   * Returned displayContent is used for the reply; remembered is passed through to callers for UI.
   */
  parseRemember?: ParseRememberFn;
  /**
   * @brief When the LLM reports ---SECURITY--- with flagged true, called with reason and snippet.
   * Only called when security block is present and flagged; backend may check approved snippets before acting.
   */
  onSecurityFlagged?: (reason: string, snippet: string) => void;
  /**
   * @brief Called after each reply is sent. Used for post-reply persistence
   * (daily log append). Not called when the merge path was used.
   * Runs fire-and-forget so it never blocks the user's reply.
   * @param params - User content, response content, session ID, and privacy flag
   */
  onAfterReply?: (params: {
    userContent: string;
    responseContent: string;
    sessionId: string;
    privacyMode: boolean;
  }) => Promise<void>;
  /**
   * @brief When set (e.g. for Maia as the brain), inject queue status into LLM context.
   * Only used when the runtime is Maia's main brain (high-level "what to do next").
   */
  getQueueStatusSummaryRef?: { current: (() => string) | null };
  /**
   * @brief Agent ID for this runtime (e.g. "maia" or sub-agent id). Used when logging LLM calls.
   */
  agentId?: string;
  /**
   * @brief When set, records each LLM request/response round for audit and per-thread views.
   * Called after each callProvider (initial and each tool round). Fire-and-forget so it does not block.
   */
  logLlmCall?: (params: {
    agentId: string;
    sessionId: string;
    threadId?: string | null;
    requestMessages: Array<{ role: string; content: string; name?: string }>;
    responseContent: string;
    responseToolCalls?: unknown[];
  }) => Promise<void>;
}

/**
 * @brief Optional callback for live streaming of assistant/tool messages during a turn.
 */
export interface HandleMessageOptions {
  /** Called whenever new chat log messages are produced (assistant text, tool_call, tool_result). */
  onIntermediateMessages?: (messages: ChatLogMessage[]) => void;
}

/**
 * @brief Agent runtime interface.
 */
export interface AgentRuntime {
  /**
   * @brief Processes an inbound message through the agent pipeline.
   * @param message - The inbound message from any channel
   * @param options - Optional callbacks (e.g. onIntermediateMessages for live UI updates)
   * @returns Promise resolving to { content, remembered? } for the assistant reply
   *
   * @note Pipeline:
   * 1. Get or create session
   * 2. Recall relevant memories
   * 3. Build system prompt with context
   * 4. Add user message to session
   * 5. Call LLM with conversation + tools
   * 6. Handle tool calls (loop until no more tool calls)
   * 7. Parse optional ---REMEMBER--- block and apply to workspace files
   * 8. Send assistant response back to channel via sendReply callback
   * 9. Return { content, remembered? } to the caller
   */
  handleMessage(message: InboundMessage, options?: HandleMessageOptions): Promise<HandleMessageResult>;

  /**
   * @brief Gets the current session ID for a channel+sender pair.
   * @param channelId - Channel identifier
   * @param senderId - Sender identifier
   * @returns Session ID or undefined
   */
  getSessionId(channelId: string, senderId: string): string | undefined;

  /**
   * @brief Returns the tool registry for this runtime (e.g. to register agent tools from index).
   */
  getToolRegistry(): ToolRegistry;
}

/**
 * @brief Creates the agent runtime.
 * @param deps - All required dependencies
 * @returns AgentRuntime instance
 *
 * @example
 * const runtime = createAgentRuntime({
 *   config, logger, events, provider, sessionManager,
 *   contextBuilder, toolRegistry, sendReply: channel.send,
 * });
 * channel.onMessage((msg) => runtime.handleMessage(msg));
 */
export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const {
    logger,
    events,
    provider,
    sessionManager,
    contextBuilder,
    toolRegistry,
    recallMemory,
    getThreadSummary,
    isPrivacyActive,
    sendReply,
    mergeStrategy,
    parseRemember,
    onSecurityFlagged,
    onAfterReply,
    getQueueStatusSummaryRef,
    agentId: runtimeAgentId,
    logLlmCall,
  } = deps;

  const agentId = runtimeAgentId ?? "maia";

  /** Maps "channelId:senderId" to session IDs */
  const sessionMap = new Map<string, string>();

  /** Maximum tool call rounds per message (prevents infinite loops) */
  const MAX_TOOL_ROUNDS = 5;

  /** Maximum retries when the LLM response is not valid structured JSON (re-prompt with error) */
  const MAX_PARSE_RETRIES = 3;

  /**
   * @brief Gets or creates a session for a channel+sender pair.
   * @param channelId - Channel identifier
   * @param senderId - Sender identifier
   * @returns Session ID
   */
  function getOrCreateSession(channelId: string, senderId: string): string {
    const key = `${channelId}:${senderId}`;
    let sessionId = sessionMap.get(key);
    if (!sessionId) {
      const session = sessionManager.create();
      sessionId = session.id;
      sessionMap.set(key, sessionId);
    }
    return sessionId;
  }

  /** @brief Max chars of system content to log when MAIA_LOG_PROMPTS=1 (rest truncated). */
  const LOG_PROMPTS_SYSTEM_MAX = 2000;
  /** @brief Whether to log full prompts (env MAIA_LOG_PROMPTS=1). */
  const logPrompts =
    typeof process !== "undefined" && process.env?.MAIA_LOG_PROMPTS === "1";

  /**
   * @brief Logs the exact conversation and tool defs sent to the LLM (when MAIA_LOG_PROMPTS=1).
   * Redacts secrets and truncates large system content for safety.
   * @param conversation - Full messages array
   * @param chatOptions - Options including tools
   * @param round - Optional tool round (0 = initial call)
   */
  function logPromptsIfEnabled(
    conversation: ChatMessage[],
    chatOptions: ChatOptions | undefined,
    round?: number,
  ): void {
    if (!logPrompts) return;
    const summary = conversation.map((m) => {
      let content = m.content;
      if (m.role === "system" && content.length > LOG_PROMPTS_SYSTEM_MAX) {
        content =
          content.slice(0, LOG_PROMPTS_SYSTEM_MAX) +
          `\n...[truncated, total ${content.length} chars]`;
      }
      content = redactSecretsFromResponse(content);
      return { role: m.role, contentLength: content.length, content };
    });
    const toolNames = chatOptions?.tools?.map((t) => t.name) ?? [];
    logger.debug("LLM prompt (exact)", {
      round: round ?? 0,
      messageCount: conversation.length,
      toolNames: toolNames.length > 0 ? toolNames : undefined,
      messages: summary,
    });
  }

  /**
   * @brief Collects the full streaming response from the provider.
   * @param messages - Conversation messages to send
   * @param options - Chat options including tools
   * @param toolRound - When in tool loop, the current round (1-based) for logging
   * @returns Complete assistant message content and any tool calls
   */
  async function callProvider(
    messages: ChatMessage[],
    options?: ChatOptions,
    toolRound?: number,
  ): Promise<{
    content: string;
    toolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }>;
  }> {
    logPromptsIfEnabled(messages, options, toolRound);
    let content = "";
    const toolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [];

    const stream = provider.chat(messages, options);
    for await (const chunk of stream) {
      content += chunk.content;
      if (chunk.toolCalls) {
        toolCalls.push(...chunk.toolCalls);
      }
    }

    return { content, toolCalls };
  }

  /**
   * @brief Calls the provider and parses structured JSON (chat_message + optional single tool).
   * If parsing fails, re-prompts the LLM with the error and retries up to MAX_PARSE_RETRIES.
   * @param conversation - Full messages to send
   * @param chatOptions - Options including tools
   * @param toolRound - Current tool round (0 = initial) for id generation
   * @returns Normalized response (content = chat_message, toolCalls = one item or [])
   */
  async function callProviderUntilValidStructuredResponse(
    conversation: ChatMessage[],
    chatOptions: ChatOptions,
    toolRound: number,
  ): Promise<{
    content: string;
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  }> {
    let currentConversation = conversation;
    let lastResponse: { content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> } = {
      content: "",
      toolCalls: [],
    };

    for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
      lastResponse = await callProvider(currentConversation, chatOptions, toolRound);
      lastResponse = {
        ...lastResponse,
        content: redactSecretsFromResponse(lastResponse.content),
      };
      const parsed = parseNewStructuredResponse(lastResponse.content);
      if (parsed) {
        const toolCalls = parsed.tool
          ? [{ id: `json_${toolRound}_0`, name: parsed.tool.name, arguments: parsed.tool.args }]
          : [];
        return {
          content: parsed.chat_message,
          toolCalls,
        };
      }
      if (attempt < MAX_PARSE_RETRIES) {
        const errorMsg =
          "System: Your response was not valid JSON. You must respond with a single JSON object only: {\"chat_message\": \"optional message to the user\", \"tool\": {\"name\": \"tool_name\", \"args\": {...}} or null}. No markdown, no code fences. If no tool, use \"tool\": null. Error: Could not parse. Try again.";
        currentConversation = [
          ...currentConversation,
          { role: "assistant" as const, content: lastResponse.content },
          { role: "user" as const, content: errorMsg, name: "system" },
        ];
        logger.debug("Structured JSON parse failed, re-prompting LLM", {
          attempt: attempt + 1,
          maxRetries: MAX_PARSE_RETRIES,
        });
      }
    }

    logger.warn("Structured JSON parse failed after retries, using raw response", {
      retries: MAX_PARSE_RETRIES,
    });
    return lastResponse;
  }

  return {
    async handleMessage(message: InboundMessage, options?: HandleMessageOptions): Promise<HandleMessageResult> {
      const onIntermediateMessages = options?.onIntermediateMessages;
      await events.emit("messageReceived", {
        channelId: message.channelId,
        senderId: message.senderId,
        messageId: message.id,
      });

      const sessionId = getOrCreateSession(message.channelId, message.senderId);
      const privacyMode = isPrivacyActive?.(sessionId) ?? false;

      // Merge path: combined reply + memory extraction every N minutes (no tools this turn).
      // Skip merge for welcome channel so new agents always get the normal path and can call set_identity.
      if (
        mergeStrategy &&
        !privacyMode &&
        message.channelId !== "welcome" &&
        (await mergeStrategy.shouldRunMerge())
      ) {
        const userMsg: ChatMessage = {
          role: "user",
          content: message.content,
          name: message.senderId,
        };
        sessionManager.addMessage(sessionId, userMsg);
        const reply = await mergeStrategy.runMerge(message.content, sessionId);
        sessionManager.addMessage(sessionId, {
          role: "assistant",
          content: reply,
        });
        const outbound: OutboundMessage = {
          channelId: message.channelId,
          recipientId: message.senderId,
          content: reply,
          replyTo: message.id,
        };
        await sendReply(outbound);
        await events.emit("messageSent", {
          channelId: message.channelId,
          recipientId: message.senderId,
          messageId: message.id,
        });
        logger.debug("Message processed (merge path)", {
          sessionId,
          responseLength: reply.length,
        });
        return { content: reply };
      }

      // Step 1: Recall relevant memories
      let memoryContext: string | undefined;
      if (recallMemory && !privacyMode) {
        try {
          memoryContext = await recallMemory(message.content);
        } catch (err) {
          logger.warn("Memory recall failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Step 2: Build context (include canonical tool list so the model describes its capabilities accurately)
      const toolDefsForPrompt = toolRegistry.definitions();
      const toolListSummary =
        toolDefsForPrompt.length > 0
          ? toolDefsForPrompt.map((d) => `- **${d.name}** – ${d.description}`).join("\n")
          : undefined;
      const contextInput: ContextInput = {
        memoryContext,
        threadSummary: getThreadSummary?.(sessionId),
        queueStatusSummary: getQueueStatusSummaryRef?.current?.() ?? undefined,
        toolListSummary,
      };
      const systemMessage =
        await contextBuilder.buildSystemPrompt(contextInput);

      // Step 3: Check compaction
      if (sessionManager.needsCompaction(sessionId)) {
        logger.info("Session needs compaction", { sessionId });
        // For now, generate a simple summary; in production, the LLM would summarize
        const messages = sessionManager.getMessages(sessionId);
        const summary = messages
          .slice(0, -5)
          .map((m) => `${m.role}: ${m.content.slice(0, 100)}`)
          .join("\n");
        await sessionManager.compact(sessionId, summary);
      }

      // Step 4: Add user message
      const userMessage: ChatMessage = {
        role: "user",
        content: message.content,
        name: message.senderId,
      };
      sessionManager.addMessage(sessionId, userMessage);

      // Step 5: Build conversation for LLM
      const conversation: ChatMessage[] = [
        systemMessage,
        ...sessionManager.getMessages(sessionId),
      ];

      // Step 6: Call LLM with tool support
      const toolDefs = toolRegistry.definitions();
      const chatOptions: ChatOptions = {};
      if (toolDefs.length > 0) {
        chatOptions.tools = toolDefs;
      }

      let response = await callProviderUntilValidStructuredResponse(
        conversation,
        chatOptions,
        0,
      );
      const threadId =
        (message.metadata?.threadId as string | undefined) ?? null;
      if (logLlmCall) {
        logLlmCall({
          agentId,
          sessionId,
          threadId,
          requestMessages: conversation.map((m) => ({
            role: m.role,
            content: m.content,
            name: m.name,
          })),
          responseContent: response.content,
          responseToolCalls: response.toolCalls?.length
            ? response.toolCalls
            : undefined,
        }).catch((err) =>
          logger.warn("logLlmCall failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      let toolRounds = 0;

      /** Accumulated from remember/security_report/progress_report tool calls (preferred over inline blocks). */
      let accumulatedRemembered: RememberedContent | undefined;
      let accumulatedSecurityFlagged: HandleMessageResult["securityFlagged"];
      let accumulatedProgressReport: HandleMessageResult["progressReport"];
      /** Human-readable tool call entries (name, summary, success, detail) for chat UI. */
      const TOOL_DETAIL_MAX_LENGTH = 2000;
      const accumulatedToolCallsSummary: Array<{
        name: string;
        summary: string;
        success: boolean;
        detail?: string;
      }> = [];

      /** Chat log entries for this turn (assistant, tool_call, tool_result) for persistence and UI. */
      const accumulatedMessages: ChatLogMessage[] = [];

      // Tool call loop: one tool per LLM round
      while (response.toolCalls.length > 0 && toolRounds < MAX_TOOL_ROUNDS) {
        toolRounds++;
        logger.debug("Processing tool call", { round: toolRounds });

        // Persist and record optional assistant message this round
        if (response.content.trim()) {
          sessionManager.addMessage(sessionId, {
            role: "assistant",
            content: response.content,
          });
          const msg = { kind: "assistant" as const, content: response.content };
          accumulatedMessages.push(msg);
          onIntermediateMessages?.([msg]);
        }

        // Exactly one tool per round
        const toolCall = response.toolCalls[0];
        const result = await toolRegistry.execute(
          toolCall.name,
          toolCall.arguments,
          {
            sessionId,
            channelId: message.channelId,
            senderId: message.senderId,
            privacyMode,
          },
        );

        // Accumulate tool results for remember/security/progress
        if (
          result.data?.rememberedContent &&
          typeof result.data.rememberedContent === "object"
        ) {
          const rc = result.data.rememberedContent as RememberedContent;
          accumulatedRemembered = { ...accumulatedRemembered, ...rc };
        }
        if (
          result.data?.securityFlagged &&
          typeof result.data.securityFlagged === "object"
        ) {
          const sf = result.data.securityFlagged as {
            reason: string;
            snippet: string;
          };
          accumulatedSecurityFlagged = {
            reason: typeof sf.reason === "string" ? sf.reason : "",
            snippet: typeof sf.snippet === "string" ? sf.snippet : "",
          };
        }
        if (
          result.data?.progressReport &&
          typeof result.data.progressReport === "object"
        ) {
          const pr = result.data.progressReport as {
            status: string;
            summary: string;
          };
          accumulatedProgressReport = {
            status: typeof pr.status === "string" ? pr.status : "",
            summary: typeof pr.summary === "string" ? pr.summary : "",
          };
        }

        const summary = formatToolCallSummary(toolCall.name, toolCall.arguments);
        const detail =
          result.content.trim().length > 0
            ? result.content.length <= TOOL_DETAIL_MAX_LENGTH
              ? result.content
              : result.content.slice(0, TOOL_DETAIL_MAX_LENGTH) + "…"
            : undefined;
        accumulatedToolCallsSummary.push({
          name: toolCall.name,
          summary,
          success: result.success,
          detail,
        });
        const toolCallMsg = {
          kind: "tool_call" as const,
          content: summary,
          toolName: toolCall.name,
          toolArgs: toolCall.arguments,
          toolSummary: summary,
        };
        const toolResultMsg = {
          kind: "tool_result" as const,
          content: result.content,
          toolName: toolCall.name,
          toolSummary: summary,
          toolSuccess: result.success,
        };
        accumulatedMessages.push(toolCallMsg);
        accumulatedMessages.push(toolResultMsg);
        onIntermediateMessages?.([toolCallMsg, toolResultMsg]);

        // Add tool result to conversation for next LLM call
        sessionManager.addMessage(sessionId, {
          role: "tool",
          content: result.content,
          toolCallId: toolCall.id,
          name: toolCall.name,
        });

        await events.emit("memoryRecalled", {
          toolName: toolCall.name,
          success: result.success,
        });

        // Re-call LLM with updated conversation
        const updatedConversation: ChatMessage[] = [
          systemMessage,
          ...sessionManager.getMessages(sessionId),
        ];
        response = await callProviderUntilValidStructuredResponse(
          updatedConversation,
          chatOptions,
          toolRounds,
        );
        if (logLlmCall) {
          logLlmCall({
            agentId,
            sessionId,
            threadId,
            requestMessages: updatedConversation.map((m) => ({
              role: m.role,
              content: m.content,
              name: m.name,
            })),
            responseContent: response.content,
            responseToolCalls: response.toolCalls?.length
              ? response.toolCalls
              : undefined,
          }).catch((err) =>
            logger.warn("logLlmCall failed", {
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }

      // Step 7: Display content and remember/security/progress (prefer tool results, fallback to inline blocks)
      const parsedBlocks = parseResponseBlocks(response.content);
      let displayContent = parsedBlocks.displayContent;

      // If displayContent is the structured JSON envelope (chat_message + tool), extract message so we never show raw JSON
      const parsedDisplay = parseNewStructuredResponse(displayContent);
      if (parsedDisplay) {
        displayContent = parsedDisplay.chat_message;
      }

      // Strip any raw tool-call JSON (whole or embedded, e.g. inside <p>) so we never show it in chat
      displayContent = stripRawToolCallJson(displayContent);
      if (displayContent.trim() && isRawToolCallContent(displayContent)) {
        displayContent = "";
      }
      // If we executed tools but have no text reply, show a short fallback so the user always sees a message
      if (!displayContent.trim() && accumulatedToolCallsSummary.length > 0) {
        displayContent =
          accumulatedToolCallsSummary.length === 1
            ? accumulatedToolCallsSummary[0].summary + "."
            : "Done.";
      }
      // If content is still empty (e.g. model output tool-call JSON as text but provider didn't run tools), show a fallback so the user never sees a blank reply
      if (!displayContent.trim()) {
        displayContent =
          "I attempted that action. If you don't see a result, try asking again or rephrase your request.";
      }

      let remembered: RememberedContent | undefined = accumulatedRemembered;
      if (
        remembered === undefined &&
        parseRemember &&
        !privacyMode &&
        parsedBlocks.rememberBlockRaw
      ) {
        const fullRaw =
          displayContent +
          "\n" +
          REMEMBER_DELIMITER +
          "\n" +
          parsedBlocks.rememberBlockRaw;
        const parsedRemember = await parseRemember(fullRaw);
        displayContent = parsedRemember.displayContent;
        remembered =
          parsedRemember.remembered && parsedRemember.rememberedContent
            ? parsedRemember.rememberedContent
            : undefined;
      }

      let securityFlagged: HandleMessageResult["securityFlagged"] =
        accumulatedSecurityFlagged;
      if (securityFlagged === undefined && parsedBlocks.security?.flagged) {
        const reason = parsedBlocks.security.reason ?? "";
        const snippet = parsedBlocks.security.snippet ?? "";
        onSecurityFlagged?.(reason, snippet);
        securityFlagged = { reason, snippet };
      }

      const progressReport: HandleMessageResult["progressReport"] =
        accumulatedProgressReport ??
        (parsedBlocks.progress?.status != null &&
        parsedBlocks.progress.summary != null
          ? {
              status: parsedBlocks.progress.status,
              summary: parsedBlocks.progress.summary,
            }
          : undefined);

      // Step 8: Add final assistant response and send reply
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: displayContent,
      };
      sessionManager.addMessage(sessionId, assistantMessage);
      const finalMsg = { kind: "assistant" as const, content: displayContent };
      accumulatedMessages.push(finalMsg);
      onIntermediateMessages?.([finalMsg]);

      const outbound: OutboundMessage = {
        channelId: message.channelId,
        recipientId: message.senderId,
        content: displayContent,
        replyTo: message.id,
      };

      await sendReply(outbound);

      await events.emit("messageSent", {
        channelId: message.channelId,
        recipientId: message.senderId,
        messageId: message.id,
      });

      // Step 9: Fire-and-forget post-reply persistence (daily log)
      if (onAfterReply) {
        onAfterReply({
          userContent: message.content,
          responseContent: displayContent,
          sessionId,
          privacyMode,
        }).catch((err) => {
          logger.warn("onAfterReply failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      logger.debug("Message processed", {
        sessionId,
        toolRounds,
        responseLength: displayContent.length,
        remembered: !!remembered,
        securityFlagged: !!securityFlagged,
        progressReport: !!progressReport,
      });

      return {
        content: displayContent,
        remembered,
        toolCallsSummary:
          accumulatedToolCallsSummary.length > 0
            ? accumulatedToolCallsSummary
            : undefined,
        messages: accumulatedMessages.length > 0 ? accumulatedMessages : undefined,
        securityFlagged,
        progressReport,
      };
    },

    getSessionId(channelId: string, senderId: string): string | undefined {
      return sessionMap.get(`${channelId}:${senderId}`);
    },

    getToolRegistry(): ToolRegistry {
      return toolRegistry;
    },
  };
}
