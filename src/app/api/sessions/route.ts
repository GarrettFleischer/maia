import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/instrumentation";
import { listSessions, createSession } from "@/lib/history";

export async function GET(req: NextRequest) {
  const ctx = getAppContext();
  const type = req.nextUrl.searchParams.get("type") as "user" | "agents" | "all" | null;
  const sessions = listSessions(ctx, type ?? "all");
  return NextResponse.json({ sessions });
}

const createSchema = z.object({
  participants: z.array(z.string()).optional(),
});

export async function POST(req: NextRequest) {
  const ctx = getAppContext();
  const body = createSchema.parse(await req.json().catch(() => ({})));
  const sessionId = createSession(ctx, body.participants ?? ["user", "maia"]);
  return NextResponse.json({ sessionId }, { status: 201 });
}
