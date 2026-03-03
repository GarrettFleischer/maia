/**
 * @fileoverview GET/PATCH/DELETE /api/tasks/[id] — get, update, delete a task via task service.
 * @module app/api/tasks/[id]/route
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureAppContext } from "@/instrumentation";
import { getTask, updateTask, deleteTask } from "@/lib/tasks";
import { apiError } from "@/lib/api-response";

const patchSchema = z.object({
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  note: z.string().optional(),
  assignedTo: z.string().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await ensureAppContext();
    const { id } = await params;
    const body = patchSchema.parse(await req.json());

    if (body.status === undefined && body.note === undefined && body.assignedTo === undefined) {
      return apiError("At least one field required", 400, "VALIDATION");
    }

    const task = updateTask(ctx, id, {
      status: body.status,
      note: body.note,
      assignedTo: body.assignedTo,
    });
    if (!task) return apiError("Task not found", 404, "NOT_FOUND");
    return NextResponse.json({ task });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError("Invalid request body", 400, "VALIDATION");
    }
    console.error("[PATCH /api/tasks/[id]]", err);
    return apiError("Internal server error", 500);
  }
}

/**
 * DELETE /api/tasks/[id] — remove a task. Emits tasks_changed. Returns 204 on success, 404 if not found.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await ensureAppContext();
    const { id } = await params;

    const deleted = deleteTask(ctx, id);
    if (!deleted) return apiError("Task not found", 404, "NOT_FOUND");
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    console.error("[DELETE /api/tasks/[id]]", err);
    return apiError("Internal server error", 500);
  }
}
