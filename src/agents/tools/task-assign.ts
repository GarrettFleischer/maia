/**
 * @fileoverview task_assign tool for Maia to assign a task to any agent (e.g. during check-in).
 * @module agents/tools/task-assign
 *
 * @brief Maia uses this to suggest or assign work to an agent when they report having nothing to do.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { TaskMonitor, TaskRecurrence } from "../task-monitor.js";

/**
 * @brief Dependencies for createTaskAssignTool.
 */
export interface TaskAssignToolDeps {
  logger: Logger;
  taskMonitor: TaskMonitor;
  /** When provided, only the returned agent ID (e.g. "maia") may use this tool. */
  resolveAgentId?: (context: ToolContext) => string | undefined;
}

/**
 * @brief Creates the task_assign tool for Maia to assign a task to an agent.
 * @param deps - Dependencies: logger, taskMonitor, optional resolveAgentId (restrict to Maia)
 * @returns AgentTool for assigning a task to another agent
 *
 * @example
 * // Maia calls: task_assign({ agentId: "research-bot", description: "Check news", scheduledAt: "...", prompt: "..." })
 */
export function createTaskAssignTool(deps: TaskAssignToolDeps): AgentTool {
  const { logger, taskMonitor, resolveAgentId } = deps;

  return {
    name: "task_assign",
    description: "Assign a task to another agent. Use during check-ins when an agent has nothing to do.",
    definition(): ToolDefinition {
      return {
        name: "task_assign",
        description:
          "Assign a scheduled task to a specific agent. Use this when an agent reports having nothing to do (e.g. during check-in). Only Maia should use this.",
        parameters: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "ID of the agent to assign the task to" },
            description: { type: "string", description: "Human-readable task description" },
            scheduledAt: { type: "string", description: "ISO datetime for when the task should run" },
            prompt: { type: "string", description: "Prompt the agent will run when the task fires" },
            recurring: {
              type: "string",
              description: "Recurrence: once, hourly, daily, weekly",
              enum: ["once", "hourly", "daily", "weekly"],
            },
          },
          required: ["agentId", "description", "scheduledAt", "prompt"],
        },
      };
    },

    async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const callerId = resolveAgentId?.(context);
      if (resolveAgentId && callerId !== "maia") {
        return {
          content: "Only Maia can assign tasks to other agents.",
          success: false,
        };
      }

      const agentId = args.agentId as string;
      const description = args.description as string;
      const scheduledAt = args.scheduledAt as string;
      const prompt = args.prompt as string;
      const recurring = (args.recurring as TaskRecurrence) ?? "once";

      if (!agentId || !description || !scheduledAt || !prompt) {
        return {
          content: "task_assign requires: agentId, description, scheduledAt, and prompt.",
          success: false,
        };
      }

      try {
        const task = await taskMonitor.addTask(agentId, {
          description,
          scheduledAt,
          recurring,
          prompt,
        });
        logger.info("Maia assigned task via task_assign", { agentId, taskId: task.id });
        return {
          content: `Task assigned to ${agentId}: "${task.description}" (ID: ${task.id}), scheduled for ${task.scheduledAt}.`,
          success: true,
          data: { taskId: task.id, agentId },
        };
      } catch (err) {
        return {
          content: `Failed to assign task: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
