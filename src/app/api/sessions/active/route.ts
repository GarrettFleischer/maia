import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureAppContext } from "@/instrumentation";
import { getActiveSessionId, setActiveSessionId, getSession } from "@/lib/history";

export async function GET() {
  const ctx = await ensureAppContext();
  const sessionId = getActiveSessionId(ctx);
  const session = sessionId ? getSession(ctx, sessionId) : null;
  return NextResponse.json({ sessionId, session });
}

const putSchema = z.object({ sessionId: z.string() });

export async function PUT(req: NextRequest) {
  const ctx = await ensureAppContext();
  const { sessionId } = putSchema.parse(await req.json());
  setActiveSessionId(ctx, sessionId);
  return NextResponse.json({ ok: true });
}
