/**
 * @fileoverview Task domain module: CRUD and event emission for the shared task board.
 * @module lib/tasks
 *
 * API routes and task tools call these functions; they do not use ctx.db directly for tasks.
 */
import { v4 as uuidv4 } from "uuid";
import type { AppContext } from "./context";
import type { Task, TaskNote } from "./types";

/** Filters for listing tasks. */
export interface ListTasksFilters {
  status?: "todo" | "in_progress" | "done";
  assignedTo?: string;
  createdBy?: string;
}

/** Input for creating a task. */
export interface CreateTaskInput {
  title: string;
  description?: string;
  assignedTo?: string | null;
  /** Defaults to "user" when called from API; task tools pass ctx.agentId. */
  createdBy?: string;
}

/** Input for updating a task (partial). */
export interface UpdateTaskInput {
  status?: "todo" | "in_progress" | "done";
  /** Note to append to the task's notes array. */
  note?: string;
  /** Agent ID to attribute the note to when note is provided. Defaults to "user". */
  noteAgentId?: string;
  assignedTo?: string | null;
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
    notes: JSON.parse((r.notes as string) ?? "[]") as TaskNote[],
  };
}

/**
 * List tasks with optional filters.
 * @param ctx - Application context
 * @param filters - Optional status, assignedTo, createdBy
 * @returns List of tasks ordered by updated_at DESC
 */
export function listTasks(
  ctx: AppContext,
  filters: ListTasksFilters = {}
): Task[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.status != null) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.assignedTo != null) {
    conditions.push("assigned_to = ?");
    params.push(filters.assignedTo);
  }
  if (filters.createdBy != null) {
    conditions.push("created_by = ?");
    params.push(filters.createdBy);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = ctx.db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/**
 * Create a task and emit tasks_changed.
 * @param ctx - Application context
 * @param input - Title and optional description, assignedTo, createdBy
 * @returns The created task
 */
export function createTask(ctx: AppContext, input: CreateTaskInput): Task {
  const id = uuidv4();
  const now = new Date().toISOString();
  const createdBy = input.createdBy ?? "user";
  ctx.db
    .prepare(
      `INSERT INTO tasks (id, title, description, status, created_by, assigned_to, created_at, updated_at, notes)
       VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, '[]')`
    )
    .run(
      id,
      input.title,
      input.description ?? "",
      createdBy,
      input.assignedTo ?? null,
      now,
      now
    );
  const row = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
  ctx.events.emit({ event: "tasks_changed", data: {} });
  return rowToTask(row);
}

/**
 * Get a single task by id, or null if not found.
 * @param ctx - Application context
 * @param id - Task id
 */
export function getTask(ctx: AppContext, id: string): Task | null {
  const row = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToTask(row);
}

/**
 * Update a task (status, append note, reassign) and emit tasks_changed.
 * @param ctx - Application context
 * @param id - Task id
 * @param input - Partial update (status, note, noteAgentId, assignedTo)
 * @returns Updated task, or null if not found
 */
export function updateTask(
  ctx: AppContext,
  id: string,
  input: UpdateTaskInput
): Task | null {
  const existing = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!existing) return null;

  const now = new Date().toISOString();
  const notes: TaskNote[] = JSON.parse((existing.notes as string) ?? "[]");
  if (input.note != null) {
    const agentId = input.noteAgentId ?? "user";
    notes.push({ agentId, content: input.note, timestamp: now });
  }

  const newStatus = input.status ?? (existing.status as string);
  const newAssignedTo = input.assignedTo !== undefined ? input.assignedTo : (existing.assigned_to as string | null);

  ctx.db
    .prepare(
      `UPDATE tasks SET status = ?, assigned_to = ?, notes = ?, updated_at = ? WHERE id = ?`
    )
    .run(newStatus, newAssignedTo, JSON.stringify(notes), now, id);

  const updated = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
  ctx.events.emit({ event: "tasks_changed", data: {} });
  return rowToTask(updated);
}

/**
 * Delete a task and emit tasks_changed.
 * @param ctx - Application context
 * @param id - Task id
 * @returns true if deleted, false if not found
 */
export function deleteTask(ctx: AppContext, id: string): boolean {
  const existing = ctx.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(id);
  if (!existing) return false;
  ctx.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  ctx.events.emit({ event: "tasks_changed", data: {} });
  return true;
}
