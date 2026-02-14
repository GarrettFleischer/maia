/**
 * @fileoverview dm_user tool for agents to send direct messages to the user.
 * @module agents/tools/dm-user
 *
 * @brief Allows any agent (or Maia) to push a direct message to the user
 * via WebSocket. Messages respect quiet-time awareness and are held as
 * pending DMs if the user is likely inactive.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { Orchestrator } from "../orchestrator.js";
import type { SubAgent } from "../factory.js";

/**
 * @brief Dependencies for createDmUserTool.
 */
export interface DmUserToolDeps {
  logger: Logger;
  orchestrator: Orchestrator;
  /** Active agents map for looking up display names */
  activeAgents: Map<string, SubAgent>;
  /** Resolves the calling agent's ID from the tool context */
  resolveAgentId: (context: ToolContext) => string | undefined;
}

/**
 * @brief Creates the dm_user tool.
 * @param deps - Dependencies: logger, orchestrator, activeAgents, resolveAgentId
 * @returns AgentTool that enables agents to DM the user
 *
 * @example
 * // LLM calls: dm_user({ message: "I found something interesting you should see!" })
 */
export function createDmUserTool(deps: DmUserToolDeps): AgentTool {
  const { logger, orchestrator, activeAgents, resolveAgentId } = deps;

  return {
    name: "dm_user",
    description: "Send a direct message to the user. The message will appear in their dashboard as a notification.",
    definition(): ToolDefinition {
      return {
        name: "dm_user",
        description:
          "Send a direct message to the user. The message appears in the dashboard as a notification. " +
          "If the user is currently inactive (quiet time), the message is held and delivered when they return. " +
          "Use this to share progress, ask questions, or communicate anything important.",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The message to send to the user",
            },
          },
          required: ["message"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const agentId = resolveAgentId(context);
      if (!agentId) {
        return {
          content: "Could not determine your agent ID. This tool is only available to agents.",
          success: false,
        };
      }

      const message = args.message as string;
      if (!message) {
        return { content: "Message is required.", success: false };
      }

      try {
        const agent = activeAgents.get(agentId);
        const senderName = agentId === "maia" ? "Maia" : (agent?.config.name ?? agentId);

        await orchestrator.sendDmToUser(agentId, senderName, message);

        const held = !orchestrator.isActiveHours();
        logger.debug("Agent DM to user", { agentId, held });

        return {
          content: held
            ? `Message sent (held for delivery — the user appears to be inactive right now). It will be delivered when they're next active.`
            : `Message sent to the user.`,
          success: true,
          data: { held },
        };
      } catch (err) {
        return {
          content: `Failed to send DM: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
