import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { zodToJsonSchema } from "../zod-to-json";
import type { Tool, ToolContext } from "./types";
import type { Task, TaskNote } from "../types";

function makeTool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>
): Tool<z.infer<S>> {
  return {
    name, description, schema, execute,
    toDefinition: () => ({ name, description, parameters: zodToJsonSchema(schema) }),
  };
}

function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    status: r.status as Task["status"],
    createdBy: r.created_by as string,
    assignedTo: (r.assigned_to as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    notes: JSON.parse(r.notes as string) as TaskNote[],
  };
}

export const taskCreateTool = makeTool(
  "task_create",
  "Create a new task on the shared kanban board. Use small, granular tasks. All agents can create tasks. Status starts as 'todo'.",
  z.object({
    title: z.string().describe("Short, actionable task title"),
    description: z.string().optional().describe("Detailed description of the task"),
    assignedTo: z.string().optional().describe("Agent ID to assign this task to (optional, leave unset for Maia to assign)"),
  }),
  async ({ title, description, assignedTo }, ctx) => {
    const id = uuidv4();
    const now = new Date().toISOString();
    ctx.db.prepare(
      `INSERT INTO tasks (id, title, description, status, created_by, assigned_to, created_at, updated_at, notes)
       VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, '[]')`
    ).run(id, title, description ?? "", ctx.agentId, assignedTo ?? null, now, now);
    const row = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
    return rowToTask(row);
  }
);

export const taskUpdateTool = makeTool(
  "task_update",
  "Update a task's status, add a note, or reassign it. At least one of status, note, or assignedTo must be provided. All agents can update tasks.",
  z.object({
    taskId: z.string().describe("The task ID to update"),
    status: z.enum(["todo", "in_progress", "done"]).optional().describe("New status for the task"),
    note: z.string().optional().describe("Note to append to the task (records which agent added it and when)"),
    assignedTo: z.string().nullable().optional().describe("Agent ID to assign to, or null to unassign"),
  }),
  async ({ taskId, status, note, assignedTo }, ctx) => {
    if (status === undefined && note === undefined && assignedTo === undefined) {
      throw new Error("At least one of status, note, or assignedTo must be provided");
    }

    const existing = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!existing) throw new Error(`Task not found: ${taskId}`);

    const now = new Date().toISOString();
    const currentNotes: TaskNote[] = JSON.parse(existing.notes as string);

    if (note) {
      currentNotes.push({ agentId: ctx.agentId, content: note, timestamp: now });
    }

    const newStatus = status ?? (existing.status as string);
    const newAssignedTo = assignedTo !== undefined ? assignedTo : (existing.assigned_to as string | null);

    ctx.db.prepare(
      `UPDATE tasks SET status = ?, assigned_to = ?, notes = ?, updated_at = ? WHERE id = ?`
    ).run(newStatus, newAssignedTo, JSON.stringify(currentNotes), now, taskId);

    const updated = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown>;
    return rowToTask(updated);
  }
);

export const taskListTool = makeTool(
  "task_list",
  "List tasks on the shared kanban board. Filter by status, assignedTo, or createdBy. Returns all tasks if no filters given.",
  z.object({
    status: z.enum(["todo", "in_progress", "done"]).optional().describe("Filter by status"),
    assignedTo: z.string().optional().describe("Filter by assigned agent ID"),
    createdBy: z.string().optional().describe("Filter by creator agent ID"),
  }),
  async ({ status, assignedTo, createdBy }, ctx) => {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status !== undefined) {
      conditions.push("status = ?");
      params.push(status);
    }
    if (assignedTo !== undefined) {
      conditions.push("assigned_to = ?");
      params.push(assignedTo);
    }
    if (createdBy !== undefined) {
      conditions.push("created_by = ?");
      params.push(createdBy);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = ctx.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];

    return rows.map(rowToTask);
  }
);

export const taskGetTool = makeTool(
  "task_get",
  "Get a single task by ID, including its full notes history.",
  z.object({
    taskId: z.string().describe("The task ID to retrieve"),
  }),
  async ({ taskId }, ctx) => {
    const row = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return rowToTask(row);
  }
);

export const taskTrackerTools: Tool[] = [taskCreateTool, taskUpdateTool, taskListTool, taskGetTool];
