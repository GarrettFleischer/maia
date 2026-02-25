import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { ensureAppContext } from "@/instrumentation";
import type { Task, TaskNote } from "@/lib/types";

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

export async function GET(req: NextRequest) {
  const ctx = await ensureAppContext();
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status");
  const assignedTo = searchParams.get("assignedTo");
  const createdBy = searchParams.get("createdBy");

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (status) { conditions.push("status = ?"); params.push(status); }
  if (assignedTo) { conditions.push("assigned_to = ?"); params.push(assignedTo); }
  if (createdBy) { conditions.push("created_by = ?"); params.push(createdBy); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = ctx.db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC`)
    .all(...params) as Record<string, unknown>[];

  return NextResponse.json({ tasks: rows.map(rowToTask) });
}

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assignedTo: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const ctx = await ensureAppContext();
  const body = createSchema.parse(await req.json());
  const id = uuidv4();
  const now = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO tasks (id, title, description, status, created_by, assigned_to, created_at, updated_at, notes)
     VALUES (?, ?, ?, 'todo', 'user', ?, ?, ?, '[]')`
  ).run(id, body.title, body.description ?? "", body.assignedTo ?? null, now, now);
  const row = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
  ctx.events.emit({ event: "tasks_changed", data: {} });
  return NextResponse.json({ task: rowToTask(row) }, { status: 201 });
}
