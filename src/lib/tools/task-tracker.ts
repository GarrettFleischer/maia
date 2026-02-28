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
  "Create a new task on the shared kanban board. Use task_list first to see existing tasks and avoid duplicates. Use small, granular tasks. All agents can create tasks. Status starts as 'todo'. Example: task_create({ title: 'Review PR' }). task_update({ id, status: 'in_progress' }). task_list({ status: 'todo' }). task_get({ id }).",
  z.object({
    title: z.string().describe("Task title"),
    desc: z.string().optional().describe("Detailed description"),
    assign: z.string().optional().describe("Agent ID to assign to"),
  }),
  async ({ title, desc, assign }, ctx) => {
    const id = uuidv4();
    const now = new Date().toISOString();
    ctx.db.prepare(
      `INSERT INTO tasks (id, title, description, status, created_by, assigned_to, created_at, updated_at, notes)
       VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, '[]')`
    ).run(id, title, desc ?? "", ctx.agentId, assign ?? null, now, now);
    const row = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
    ctx.events.emit({ event: "tasks_changed", data: {} });
    return rowToTask(row);
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
    ctx.events.emit({ event: "tasks_changed", data: {} });
    return rowToTask(updated);
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
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status !== undefined) {
      conditions.push("status = ?");
      params.push(status);
    } else {
      conditions.push("status != 'done'");
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
  "Get a single task by ID, including its full notes history. Example: task_get({ id: 'id' }).",
  z.object({
    id: z.string().describe("Task ID"),
  }),
  async ({ id: taskId }, ctx) => {
    const row = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return rowToTask(row);
  }
);

export const taskTrackerTools: Tool[] = [taskCreateTool, taskUpdateTool, taskListTool, taskGetTool];
