import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveSessionId, setActiveSessionId, getSession } from "@/lib/history";

export async function GET() {
  const sessionId = getActiveSessionId();
  const session = sessionId ? getSession(sessionId) : null;
  return NextResponse.json({ sessionId, session });
}

const putSchema = z.object({ sessionId: z.string() });

export async function PUT(req: NextRequest) {
  const { sessionId } = putSchema.parse(await req.json());
  setActiveSessionId(sessionId);
  return NextResponse.json({ ok: true });
}
