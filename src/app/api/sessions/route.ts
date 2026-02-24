/**
 * @fileoverview API route for thread (session) list and create/rename/delete. GET list, POST create, PATCH rename, DELETE by id.
 * @module app/api/sessions/route
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureAppContext } from "@/instrumentation";
import { listSessions, createSession, getSession, updateSessionMeta, deleteSession } from "@/lib/history";

export async function GET(req: NextRequest) {
  const ctx = await ensureAppContext();
  const type = req.nextUrl.searchParams.get("type") as "user" | "agents" | "all" | null;
  const sessions = listSessions(ctx, type ?? "all");
  return NextResponse.json({ sessions });
}

const createSchema = z.object({
  participants: z.array(z.string()).optional(),
  type: z.enum(["user", "agents"]).optional(),
});

export async function POST(req: NextRequest) {
  const ctx = await ensureAppContext();
  const body = createSchema.parse(await req.json().catch(() => ({})));
  const participants = body.participants ?? ["user", "maia"];
  const type = body.type ?? "user";
  const sessionId = createSession(ctx, participants, type);
  return NextResponse.json({ sessionId }, { status: 201 });
}

const patchSchema = z.object({
  sessionId: z.string().uuid(),
  name: z.string(),
});

/**
 * PATCH /api/sessions
 * Renames a thread (session) by id.
 * @returns 204 No Content on success, 404 if session does not exist
 */
export async function PATCH(req: NextRequest) {
  const ctx = await ensureAppContext();
  const body = patchSchema.parse(await req.json().catch(() => ({})));
  const session = getSession(ctx, body.sessionId);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  updateSessionMeta(ctx, body.sessionId, { name: body.name });
  return new NextResponse(null, { status: 204 });
}

const deleteSchema = z.object({ sessionId: z.string().uuid() });

/**
 * DELETE /api/sessions
 * Deletes a thread (session) by id.
 * @returns 204 No Content on success, 404 if session does not exist
 */
export async function DELETE(req: NextRequest) {
  const ctx = await ensureAppContext();
  const body = deleteSchema.parse(await req.json().catch(() => ({})));
  const deleted = deleteSession(ctx, body.sessionId);
  if (!deleted) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
