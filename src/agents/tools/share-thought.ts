/**
 * @fileoverview share_thought tool for agents to append to their thinking monologue.
 * @module agents/tools/share-thought
 *
 * @brief Appends a thought to the agent's visible "internal monologue" in the dashboard sidebar.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";

/**
 * @brief Dependencies for createShareThoughtTool.
 */
export interface ShareThoughtToolDeps {
  logger: Logger;
  /** Resolves the calling agent's ID from the tool context */
  resolveAgentId: (context: ToolContext) => string | undefined;
  /** Called when an agent shares a thought (agentId, content). Caller pushes to store and broadcasts. */
  onThought: (agentId: string, content: string) => void;
}

/**
 * @brief Creates the share_thought tool.
 * @param deps - Dependencies: logger, resolveAgentId, onThought
 * @returns AgentTool that appends to the agent's thinking sidebar
 */
export function createShareThoughtTool(deps: ShareThoughtToolDeps): AgentTool {
  const { logger, resolveAgentId, onThought } = deps;

  return {
    name: "share_thought",
    description:
      "Append a short thought to your visible thinking monologue in the dashboard. Use for internal reasoning, plans, or what you're considering.",
    definition(): ToolDefinition {
      return {
        name: "share_thought",
        description:
          "Append a thought to your thinking monologue (visible in the dashboard sidebar). " +
          "Use for internal reasoning, plans, doubts, or what you're considering next. Keep each thought brief.",
        parameters: {
          type: "object",
          properties: {
            thought: {
              type: "string",
              description: "The thought to append (one short sentence or phrase)",
            },
          },
          required: ["thought"],
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

      const thought = typeof args.thought === "string" ? args.thought.trim() : "";
      if (!thought) {
        return { content: "Thought content is required.", success: false };
      }

      try {
        onThought(agentId, thought);
        logger.debug("Agent thought shared", { agentId, length: thought.length });
        return { content: "Thought recorded.", success: true };
      } catch (err) {
        logger.warn("Share thought failed", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: err instanceof Error ? err.message : "Failed to record thought.",
          success: false,
        };
      }
    },
  };
}
