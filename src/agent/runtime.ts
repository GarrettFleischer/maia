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

/**
 * @brief Result of handling a message: display content and optional remembered content for UI.
 */
export interface HandleMessageResult {
  /** Assistant reply text to show to the user. */
  content: string;
  /** When the LLM included a remember block and it was applied; content per file for hover tooltip. */
  remembered?: RememberedContent;
}

/**
 * @brief Parses optional ---REMEMBER--- block from LLM response and appends to workspace files.
 * When present, runtime uses returned displayContent for reply and passes rememberedContent to result.
 */
export type ParseRememberFn = (
  rawContent: string
) => Promise<{ displayContent: string; remembered: boolean; rememberedContent?: RememberedContent }>;

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
}

/**
 * @brief Agent runtime interface.
 */
export interface AgentRuntime {
  /**
   * @brief Processes an inbound message through the agent pipeline.
   * @param message - The inbound message from any channel
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
  handleMessage(message: InboundMessage): Promise<HandleMessageResult>;

  /**
   * @brief Gets the current session ID for a channel+sender pair.
   * @param channelId - Channel identifier
   * @param senderId - Sender identifier
   * @returns Session ID or undefined
   */
  getSessionId(channelId: string, senderId: string): string | undefined;
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
    onAfterReply,
  } = deps;

  /** Maps "channelId:senderId" to session IDs */
  const sessionMap = new Map<string, string>();

  /** Maximum tool call rounds per message (prevents infinite loops) */
  const MAX_TOOL_ROUNDS = 5;

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

  /**
   * @brief Collects the full streaming response from the provider.
   * @param messages - Conversation messages to send
   * @param options - Chat options including tools
   * @returns Complete assistant message content and any tool calls
   */
  async function callProvider(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }> {
    let content = "";
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

    const stream = provider.chat(messages, options);
    for await (const chunk of stream) {
      content += chunk.content;
      if (chunk.toolCalls) {
        toolCalls.push(...chunk.toolCalls);
      }
    }

    return { content, toolCalls };
  }

  return {
    async handleMessage(message: InboundMessage): Promise<HandleMessageResult> {
      await events.emit("messageReceived", {
        channelId: message.channelId,
        senderId: message.senderId,
        messageId: message.id,
      });

      const sessionId = getOrCreateSession(message.channelId, message.senderId);
      const privacyMode = isPrivacyActive?.(sessionId) ?? false;

      // Merge path: combined reply + memory extraction every N minutes (no tools this turn)
      if (mergeStrategy && !privacyMode && (await mergeStrategy.shouldRunMerge())) {
        const userMsg: ChatMessage = {
          role: "user",
          content: message.content,
          name: message.senderId,
        };
        sessionManager.addMessage(sessionId, userMsg);
        const reply = await mergeStrategy.runMerge(message.content, sessionId);
        sessionManager.addMessage(sessionId, { role: "assistant", content: reply });
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
        logger.debug("Message processed (merge path)", { sessionId, responseLength: reply.length });
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

      // Step 2: Build context
      const contextInput: ContextInput = {
        memoryContext,
        threadSummary: getThreadSummary?.(sessionId),
      };
      const systemMessage = await contextBuilder.buildSystemPrompt(contextInput);

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

      let response = await callProvider(conversation, chatOptions);
      response = {
        ...response,
        content: redactSecretsFromResponse(response.content),
      };
      let toolRounds = 0;

      // Tool call loop
      while (response.toolCalls.length > 0 && toolRounds < MAX_TOOL_ROUNDS) {
        toolRounds++;
        logger.debug("Processing tool calls", {
          round: toolRounds,
          count: response.toolCalls.length,
        });

        // Add assistant message with tool calls
        if (response.content) {
          sessionManager.addMessage(sessionId, {
            role: "assistant",
            content: response.content,
          });
        }

        // Execute each tool call
        for (const toolCall of response.toolCalls) {
          const result = await toolRegistry.execute(
            toolCall.name,
            toolCall.arguments,
            {
              sessionId,
              channelId: message.channelId,
              senderId: message.senderId,
              privacyMode,
            }
          );

          // Add tool result to conversation
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
        }

        // Re-call LLM with updated conversation
        const updatedConversation: ChatMessage[] = [
          systemMessage,
          ...sessionManager.getMessages(sessionId),
        ];
        response = await callProvider(updatedConversation, chatOptions);
        response = {
          ...response,
          content: redactSecretsFromResponse(response.content),
        };
      }

      // Step 7: Parse optional ---REMEMBER--- block and get display content
      let displayContent = response.content;
      let remembered: RememberedContent | undefined;
      if (parseRemember && !privacyMode) {
        const parsed = await parseRemember(response.content);
        displayContent = parsed.displayContent;
        remembered = parsed.remembered && parsed.rememberedContent ? parsed.rememberedContent : undefined;
      }

      // Step 8: Add final assistant response and send reply
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: displayContent,
      };
      sessionManager.addMessage(sessionId, assistantMessage);

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
      });

      return { content: displayContent, remembered };
    },

    getSessionId(channelId: string, senderId: string): string | undefined {
      return sessionMap.get(`${channelId}:${senderId}`);
    },
  };
}
