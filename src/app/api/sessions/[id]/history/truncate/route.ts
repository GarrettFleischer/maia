/**
 * @fileoverview POST /api/sessions/[id]/history/truncate — truncate session history after a given index.
 * Keeps entries 0..keepThroughIndex (inclusive); removes the rest. Used by re-send to clear history
 * after a message before re-posting it.
 * @module app/api/sessions/[id]/history/truncate/route
 *
 * @example
 * POST /api/sessions/abc-123/history/truncate
 * Body: { "keepThroughIndex": 3 }
 * Response: 200 { "ok": true } or 400 invalid body, 404 session not found
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureAppContext } from "@/instrumentation";
import { getSession, truncateHistoryAfterIndex } from "@/lib/history";

const bodySchema = z.object({
  keepThroughIndex: z.number().int().min(-1),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await ensureAppContext();
  const { id: sessionId } = await params;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid request body; need keepThroughIndex (integer >= -1)" },
      { status: 400 }
    );
  }

  const session = getSession(ctx, sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  truncateHistoryAfterIndex(ctx, sessionId, body.keepThroughIndex);
  return NextResponse.json({ ok: true });
}
