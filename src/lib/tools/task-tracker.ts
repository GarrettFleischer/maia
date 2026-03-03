/**
 * @fileoverview Task tools: create, update, list, get tasks via the task service.
 * @module lib/tools/task-tracker
 */
import { z } from "zod";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import { listTasks, createTask, getTask, updateTask } from "../tasks";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>
): Tool<z.infer<S>> {
  return {
    name,
    description,
    schema,
    execute,
    toDefinition: () => ({ name, description, parameters: zodToJsonSchema(schema) }),
  };
}

export const taskCreateTool = makeTool(
  "task_create",
  "Create a new task on the shared kanban board. Use task_list first to see existing tasks and avoid duplicates. Use small, granular tasks. All agents can create tasks. Status starts as 'todo'. Example: task_create({ title: 'Review PR' }). task_update({ id, status: 'in_progress' }). task_list({ status: 'todo' }). task_get({ id }).",
  z.object({
    title: z.string().describe("Task title"),
    desc: z.string().optional().describe("Detailed description"),
    assign: z.string().optional().describe("Agent ID to assign to"),
  }),
  async ({ title, desc, assign }, ctx) => {
    return createTask(ctx, {
      title,
      description: desc,
      assignedTo: assign ?? null,
      createdBy: ctx.agentId,
    });
  }
);

export const taskUpdateTool = makeTool(
  "task_update",
  "Update a task's status, add a note, or reassign it. Use task_list first to find the task ID. At least one of status, note, or assign must be provided. All agents can update tasks. Example: task_update({ id: 'id', status: 'in_progress' }).",
  z.object({
    id: z.string().describe("Task ID"),
    status: z.enum(["todo", "in_progress", "done"]).optional().describe("New status"),
    note: z.string().optional().describe("Note to append"),
    assign: z.string().nullable().optional().describe("Agent ID or null to unassign"),
  }),
  async ({ id: taskId, status, note, assign: assignedTo }, ctx) => {
    if (status === undefined && note === undefined && assignedTo === undefined) {
      throw new Error("At least one of status, note, or assign must be provided");
    }
    const task = updateTask(ctx, taskId, {
      status,
      note,
      assignedTo,
      noteAgentId: ctx.agentId,
    });
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
);

export const taskListTool = makeTool(
  "task_list",
  "List tasks on the shared kanban board. Filter by column (status: todo/in_progress/done) or agent id (assignedTo, createdBy). By default excludes completed (done) tasks unless you filter by status. Example: task_list({ status: 'todo' }).",
  z.object({
    status: z.enum(["todo", "in_progress", "done"]).optional().describe("Filter by status"),
    assign: z.string().optional().describe("Filter by assigned agent"),
    created: z.string().optional().describe("Filter by creator agent"),
  }),
  async ({ status, assign: assignedTo, created: createdBy }, ctx) => {
    const tasks = listTasks(ctx, {
      status,
      assignedTo,
      createdBy,
    });
    if (status === undefined) {
      return tasks.filter((t) => t.status !== "done");
    }
    return tasks;
  }
);

export const taskGetTool = makeTool(
  "task_get",
  "Get a single task by ID, including its full notes history. Example: task_get({ id: 'id' }).",
  z.object({
    id: z.string().describe("Task ID"),
  }),
  async ({ id: taskId }, ctx) => {
    const task = getTask(ctx, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
);

export const taskTrackerTools: Tool[] = [taskCreateTool, taskUpdateTool, taskListTool, taskGetTool];
