/**
 * @fileoverview task_manage tool allowing agents to CRUD their own tasks.json.
 * @module agents/tools/task-manage
 *
 * @brief Agents use this tool to add, list, update, and remove tasks from
 * their own tasks.json file. Each agent can only manage its own tasks.
 */

import type { Logger, ToolDefinition } from "../../core/types.js";
import type { AgentTool, ToolContext, ToolResult } from "../../agent/tools/base.js";
import type { TaskMonitor, TaskRecurrence } from "../task-monitor.js";

/**
 * @brief Dependencies for createTaskManageTool.
 */
export interface TaskManageToolDeps {
  logger: Logger;
  taskMonitor: TaskMonitor;
  /** Returns the agent ID for a given context (e.g. from channelId "agent:research-bot") */
  resolveAgentId: (context: ToolContext) => string | undefined;
}

/**
 * @brief Creates the task_manage tool for agents to manage their own tasks.
 * @param deps - Dependencies: logger, taskMonitor, resolveAgentId
 * @returns AgentTool for task management
 *
 * @example
 * // LLM calls: task_manage({ action: "add", description: "Check news", scheduledAt: "...", recurring: "daily", prompt: "..." })
 */
export function createTaskManageTool(deps: TaskManageToolDeps): AgentTool {
  const { logger, taskMonitor, resolveAgentId } = deps;

  return {
    name: "task_manage",
    description: "Manage your scheduled tasks: add, list, update, or remove tasks from your task list.",
    definition(): ToolDefinition {
      return {
        name: "task_manage",
        description:
          "Manage your own scheduled tasks. Actions: 'add' a new task, 'list' all tasks, 'remove' a task by ID, 'update' a task.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "Action to perform: add, list, remove, update",
              enum: ["add", "list", "remove", "update"],
            },
            taskId: {
              type: "string",
              description: "Task ID (required for remove and update)",
            },
            description: {
              type: "string",
              description: "Human-readable task description (for add)",
            },
            scheduledAt: {
              type: "string",
              description: "ISO datetime for when the task should run (for add)",
            },
            recurring: {
              type: "string",
              description: "Recurrence: once, hourly, daily, weekly, or null (for add/update)",
              enum: ["once", "hourly", "daily", "weekly"],
            },
            prompt: {
              type: "string",
              description: "Prompt to execute when the task fires (for add/update)",
            },
          },
          required: ["action"],
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

      const action = args.action as string;

      try {
        switch (action) {
          case "list": {
            const tasks = await taskMonitor.getTasks(agentId);
            if (tasks.length === 0) {
              return { content: "You have no scheduled tasks.", success: true };
            }
            const lines = tasks.map((t) =>
              `- [${t.id}] "${t.description}" | Scheduled: ${t.scheduledAt} | Recurring: ${t.recurring ?? "once"} | Status: ${t.status} | Last run: ${t.lastRunAt ?? "never"}`
            );
            return {
              content: `Your tasks:\n${lines.join("\n")}`,
              success: true,
              data: { count: tasks.length },
            };
          }

          case "add": {
            const description = args.description as string;
            const scheduledAt = args.scheduledAt as string;
            const prompt = args.prompt as string;

            if (!description || !scheduledAt || !prompt) {
              return {
                content: "To add a task, provide: description, scheduledAt (ISO datetime), and prompt.",
                success: false,
              };
            }

            const recurring = (args.recurring as TaskRecurrence) ?? "once";
            const task = await taskMonitor.addTask(agentId, {
              description,
              scheduledAt,
              recurring,
              prompt,
            });

            logger.info("Agent added task via tool", { agentId, taskId: task.id });
            return {
              content: `Task added: "${task.description}" (ID: ${task.id}), scheduled for ${task.scheduledAt}, recurring: ${task.recurring ?? "once"}`,
              success: true,
              data: { taskId: task.id },
            };
          }

          case "remove": {
            const taskId = args.taskId as string;
            if (!taskId) {
              return { content: "Provide taskId to remove.", success: false };
            }
            const removed = await taskMonitor.removeTask(agentId, taskId);
            if (!removed) {
              return { content: `Task '${taskId}' not found.`, success: false };
            }
            logger.info("Agent removed task via tool", { agentId, taskId });
            return { content: `Task '${taskId}' removed.`, success: true };
          }

          case "update": {
            const taskId = args.taskId as string;
            if (!taskId) {
              return { content: "Provide taskId to update.", success: false };
            }
            const tasks = await taskMonitor.getTasks(agentId);
            const task = tasks.find((t) => t.id === taskId);
            if (!task) {
              return { content: `Task '${taskId}' not found.`, success: false };
            }

            if (args.description !== undefined) task.description = args.description as string;
            if (args.scheduledAt !== undefined) task.scheduledAt = args.scheduledAt as string;
            if (args.recurring !== undefined) task.recurring = args.recurring as TaskRecurrence;
            if (args.prompt !== undefined) task.prompt = args.prompt as string;

            await taskMonitor.writeTasks(agentId, tasks);
            logger.info("Agent updated task via tool", { agentId, taskId });
            return {
              content: `Task '${taskId}' updated.`,
              success: true,
            };
          }

          default:
            return { content: `Unknown action: '${action}'. Use: add, list, remove, update.`, success: false };
        }
      } catch (err) {
        return {
          content: `Task operation failed: ${err instanceof Error ? err.message : String(err)}`,
          success: false,
        };
      }
    },
  };
}
