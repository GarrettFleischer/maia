import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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

const patchSchema = z.object({
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  note: z.string().optional(),
  assignedTo: z.string().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await ensureAppContext();
  const { id } = await params;
  const body = patchSchema.parse(await req.json());

  if (body.status === undefined && body.note === undefined && body.assignedTo === undefined) {
    return NextResponse.json({ error: "At least one field required" }, { status: 400 });
  }

  const existing = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!existing) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const now = new Date().toISOString();
  const notes: TaskNote[] = JSON.parse(existing.notes as string);
  if (body.note) {
    notes.push({ agentId: "user", content: body.note, timestamp: now });
  }

  const newStatus = body.status ?? (existing.status as string);
  const newAssignedTo = body.assignedTo !== undefined ? body.assignedTo : (existing.assigned_to as string | null);

  ctx.db.prepare(
    `UPDATE tasks SET status = ?, assigned_to = ?, notes = ?, updated_at = ? WHERE id = ?`
  ).run(newStatus, newAssignedTo, JSON.stringify(notes), now, id);

  const updated = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
  return NextResponse.json({ task: rowToTask(updated) });
}
