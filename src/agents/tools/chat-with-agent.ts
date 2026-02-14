/**
 * @fileoverview chat_with_agent tool for inter-agent communication.
 * @module agents/tools/chat-with-agent
 *
 * @brief Allows an agent to initiate or continue a conversation with another
 * agent. Messages are routed through the orchestrator, creating a thread and
 * recording all messages for dashboard visibility.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { Orchestrator } from "../orchestrator.js";

/**
 * @brief Dependencies for createChatWithAgentTool.
 */
export interface ChatWithAgentToolDeps {
  logger: Logger;
  orchestrator: Orchestrator;
  /** Resolves the calling agent's ID from the tool context */
  resolveAgentId: (context: ToolContext) => string | undefined;
}

/**
 * @brief Creates the chat_with_agent tool.
 * @param deps - Dependencies: logger, orchestrator, resolveAgentId
 * @returns AgentTool that enables inter-agent chat
 *
 * @example
 * // LLM calls: chat_with_agent({ agentId: "data-bot", message: "Can you pull the latest metrics?" })
 */
export function createChatWithAgentTool(deps: ChatWithAgentToolDeps): AgentTool {
  const { logger, orchestrator, resolveAgentId } = deps;

  return {
    name: "chat_with_agent",
    description: "Send a message to another agent and receive their response. Creates a conversation thread.",
    definition(): ToolDefinition {
      return {
        name: "chat_with_agent",
        description:
          "Chat with another agent. Provide the target agent's ID and your message. " +
          "A conversation thread is created so the user can see the exchange.",
        parameters: {
          type: "object",
          properties: {
            agentId: {
              type: "string",
              description: "The ID of the agent you want to chat with",
            },
            message: {
              type: "string",
              description: "The message to send to the other agent",
            },
          },
          required: ["agentId", "message"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const fromAgentId = resolveAgentId(context);
      if (!fromAgentId) {
        return {
          content: "Could not determine your agent ID. This tool is only available to agents.",
          success: false,
        };
      }

      const toAgentId = args.agentId as string;
      const message = args.message as string;

      if (!toAgentId || !message) {
        return {
          content: "Both agentId and message are required.",
          success: false,
        };
      }

      try {
        const response = await orchestrator.agentToAgentChat(fromAgentId, toAgentId, message);
        logger.debug("Agent-to-agent chat completed", { from: fromAgentId, to: toAgentId });
        return {
          content: `[${toAgentId}]: ${response}`,
          success: true,
          data: { fromAgentId, toAgentId, response },
        };
      } catch (err) {
        return {
          content: `Failed to chat with agent '${toAgentId}': ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
