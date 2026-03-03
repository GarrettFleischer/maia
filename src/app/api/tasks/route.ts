/**
 * @fileoverview GET/POST /api/tasks — list and create tasks via task service.
 * @module app/api/tasks/route
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureAppContext } from "@/instrumentation";
import { listTasks, createTask } from "@/lib/tasks";
import { apiError } from "@/lib/api-response";

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assignedTo: z.string().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const ctx = await ensureAppContext();
    const { searchParams } = req.nextUrl;
    const status = searchParams.get("status") as "todo" | "in_progress" | "done" | null;
    const assignedTo = searchParams.get("assignedTo") ?? undefined;
    const createdBy = searchParams.get("createdBy") ?? undefined;

    const filters = {
      ...(status && { status }),
      ...(assignedTo && { assignedTo }),
      ...(createdBy && { createdBy }),
    };
    const tasks = listTasks(ctx, filters);
    return NextResponse.json({ tasks });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError("Invalid request", 400, "VALIDATION");
    }
    console.error("[GET /api/tasks]", err);
    return apiError("Internal server error", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await ensureAppContext();
    const body = createSchema.parse(await req.json());
    const task = createTask(ctx, {
      title: body.title,
      description: body.description,
      assignedTo: body.assignedTo ?? null,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError("Invalid request body", 400, "VALIDATION");
    }
    console.error("[POST /api/tasks]", err);
    return apiError("Internal server error", 500);
  }
}
