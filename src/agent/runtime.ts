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
import type { ContextBuilder, ContextInput } from "./context.js";
import type { SessionManager } from "./session.js";
import type { ToolRegistry } from "./tools/registry.js";

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
}

/**
 * @brief Agent runtime interface.
 */
export interface AgentRuntime {
  /**
   * @brief Processes an inbound message through the agent pipeline.
   * @param message - The inbound message from any channel
   * @returns Promise resolving to the assistant's response content
   *
   * @note Pipeline:
   * 1. Get or create session
   * 2. Recall relevant memories
   * 3. Build system prompt with context
   * 4. Add user message to session
   * 5. Call LLM with conversation + tools
   * 6. Handle tool calls (loop until no more tool calls)
   * 7. Send assistant response back to channel via sendReply callback
   * 8. Return the response content to the caller
   */
  handleMessage(message: InboundMessage): Promise<string>;

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
    async handleMessage(message: InboundMessage): Promise<string> {
      await events.emit("messageReceived", {
        channelId: message.channelId,
        senderId: message.senderId,
        messageId: message.id,
      });

      const sessionId = getOrCreateSession(message.channelId, message.senderId);
      const privacyMode = isPrivacyActive?.(sessionId) ?? false;

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
      }

      // Step 7: Add final assistant response and send reply
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response.content,
      };
      sessionManager.addMessage(sessionId, assistantMessage);

      const outbound: OutboundMessage = {
        channelId: message.channelId,
        recipientId: message.senderId,
        content: response.content,
        replyTo: message.id,
      };

      await sendReply(outbound);

      await events.emit("messageSent", {
        channelId: message.channelId,
        recipientId: message.senderId,
        messageId: message.id,
      });

      logger.debug("Message processed", {
        sessionId,
        toolRounds,
        responseLength: response.content.length,
      });

      return response.content;
    },

    getSessionId(channelId: string, senderId: string): string | undefined {
      return sessionMap.get(`${channelId}:${senderId}`);
    },
  };
}
