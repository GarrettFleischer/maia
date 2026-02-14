/**
 * @fileoverview share_thread tool for sharing conversation threads between agents.
 * @module agents/tools/share-thread
 *
 * @brief Allows an agent to share a conversation thread it's part of with
 * another agent. The shared thread becomes visible to the target agent.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { ThreadService } from "../../threads/service.js";

/**
 * @brief Dependencies for createShareThreadTool.
 */
export interface ShareThreadToolDeps {
  logger: Logger;
  threadService: ThreadService;
  /** Resolves the calling agent's ID from the tool context */
  resolveAgentId: (context: ToolContext) => string | undefined;
}

/**
 * @brief Creates the share_thread tool.
 * @param deps - Dependencies: logger, threadService, resolveAgentId
 * @returns AgentTool that enables thread sharing between agents
 *
 * @example
 * // LLM calls: share_thread({ threadId: "abc-123", agentId: "data-bot" })
 */
export function createShareThreadTool(deps: ShareThreadToolDeps): AgentTool {
  const { logger, threadService, resolveAgentId } = deps;

  return {
    name: "share_thread",
    description: "Share a conversation thread you're part of with another agent.",
    definition(): ToolDefinition {
      return {
        name: "share_thread",
        description:
          "Share a conversation thread with another agent. You must be a participant in the thread. " +
          "The target agent will be able to see the thread and its messages.",
        parameters: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: "The ID of the thread to share",
            },
            agentId: {
              type: "string",
              description: "The ID of the agent to share the thread with",
            },
          },
          required: ["threadId", "agentId"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const sharingAgentId = resolveAgentId(context);
      if (!sharingAgentId) {
        return {
          content: "Could not determine your agent ID. This tool is only available to agents.",
          success: false,
        };
      }

      const threadId = args.threadId as string;
      const targetAgentId = args.agentId as string;

      if (!threadId || !targetAgentId) {
        return {
          content: "Both threadId and agentId are required.",
          success: false,
        };
      }

      try {
        // Verify the thread exists and the sharing agent is a participant
        const thread = await threadService.getThread(threadId);
        if (!thread) {
          return { content: `Thread '${threadId}' not found.`, success: false };
        }

        if (!thread.participants.includes(sharingAgentId)) {
          return {
            content: `You are not a participant in thread '${threadId}'. You can only share threads you're part of.`,
            success: false,
          };
        }

        await threadService.shareThread(threadId, targetAgentId, sharingAgentId);

        logger.info("Thread shared", { threadId, sharedWith: targetAgentId, sharedBy: sharingAgentId });
        return {
          content: `Thread '${threadId}' shared with agent '${targetAgentId}'.`,
          success: true,
          data: { threadId, sharedWith: targetAgentId },
        };
      } catch (err) {
        return {
          content: `Failed to share thread: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
