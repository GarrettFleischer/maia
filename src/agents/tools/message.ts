/**
 * @fileoverview Unified message tool: send to user, Maia, or any agent.
 * @module agents/tools/message
 *
 * @brief Single tool to message the user (recipientId "user"), Maia ("maia"),
 * or any agent by id. Replaces separate dm_user and chat_with_agent.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { Orchestrator } from "../orchestrator.js";
import type { SubAgent } from "../factory.js";

/**
 * @brief Optional guard: allow only one message to user per run on a given channel (e.g. maia:startup).
 * @note When set, the first message(recipientId: 'user') in that channel succeeds; further ones in the same run return a hint instead of sending.
 */
export interface SingleUserMessageGuard {
  /** Channel id to enforce (e.g. "maia:startup") */
  channelId: string;
  /** Ref set to true after first user message this run; caller must reset to false at run start */
  sentRef: { current: boolean };
}

/**
 * @brief Dependencies for createMessageTool.
 */
export interface MessageToolDeps {
  logger: Logger;
  orchestrator: Orchestrator;
  /** Active agents map for looking up display names */
  activeAgents: Map<string, SubAgent>;
  /** Resolves the calling agent's ID from the tool context */
  resolveAgentId: (context: ToolContext) => string | undefined;
  /** Optional: allow only one message to user per run when context.channelId matches */
  singleUserMessageGuard?: SingleUserMessageGuard;
}

/**
 * @brief Creates the message tool: send to user, maia, or any agent.
 * @param deps - Dependencies: logger, orchestrator, activeAgents, resolveAgentId
 * @returns AgentTool that enables messaging user/maia/agents
 *
 * @example
 * // LLM calls: message({ recipientId: "user", content: "Status update: ..." })
 * // LLM calls: message({ recipientId: "maia", content: "Need direction on X." })
 * // LLM calls: message({ recipientId: "data-bot", content: "Pull latest metrics?" })
 */
export function createMessageTool(deps: MessageToolDeps): AgentTool {
  const { logger, orchestrator, activeAgents, resolveAgentId, singleUserMessageGuard } = deps;

  return {
    name: "message",
    description:
      "Send a message to the user (recipientId 'user'), Maia ('maia'), or any agent by id. For user, message is delivered to the dashboard; for maia/agent you get their reply.",
    definition(): ToolDefinition {
      return {
        name: "message",
        description:
          "Send a message to the user, Maia, or another agent. Use recipientId: 'user' to message the user (appears in dashboard; quiet-time aware). " +
          "Use 'maia' or an agent id to message Maia or that agent and receive their reply. Use agent_list to see agent ids.",
        parameters: {
          type: "object",
          properties: {
            recipientId: {
              type: "string",
              description: "Who to send to: 'user', 'maia', or an agent id (e.g. from agent_list)",
            },
            content: {
              type: "string",
              description: "The message content",
            },
          },
          required: ["recipientId", "content"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const senderId = resolveAgentId(context);
      if (!senderId) {
        return {
          content: "Could not determine your agent ID. This tool is only available to agents.",
          success: false,
        };
      }

      const recipientId = typeof args.recipientId === "string" ? args.recipientId.trim() : "";
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!recipientId || !content) {
        return { content: "recipientId and content are required.", success: false };
      }

      try {
        if (recipientId === "user") {
          // When replying in a thread, the HTTP/WS handler adds the reply to the thread and
          // pushes thread_update. Skip sendDmToUser here to avoid duplicate messages in the UI.
          if (context.channelId.startsWith("thread:")) {
            return {
              content: "Your reply will appear in the thread.",
              success: true,
              data: { inThread: true },
            };
          }
          if (
            singleUserMessageGuard &&
            context.channelId === singleUserMessageGuard.channelId
          ) {
            if (singleUserMessageGuard.sentRef.current) {
              return {
                content:
                  "You already sent your one message to the user this run. Continue with your planned actions (e.g. message agents, task_manage, share_thought). Do not send another user message.",
                success: true,
                data: { skippedDuplicate: true },
              };
            }
            singleUserMessageGuard.sentRef.current = true;
          }
          const agent = activeAgents.get(senderId);
          const senderName = senderId === "maia" ? "Maia" : (agent?.config.name ?? senderId);
          await orchestrator.sendDmToUser(senderId, senderName, content);
          const held = !orchestrator.isActiveHours();
          logger.debug("Message to user", { senderId, held });
          return {
            content: held
              ? "Message sent (held for delivery—user appears inactive). It will be delivered when they're next active."
              : "Message sent to the user.",
            success: true,
            data: { held },
          };
        }

        const response = await orchestrator.agentToAgentChat(senderId, recipientId, content);
        logger.debug("Message to agent/maia completed", { from: senderId, to: recipientId });
        return {
          content: `[${recipientId}]: ${response}`,
          success: true,
          data: { fromAgentId: senderId, toAgentId: recipientId, response },
        };
      } catch (err) {
        return {
          content: `Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
