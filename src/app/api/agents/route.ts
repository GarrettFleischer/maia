import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { listAgents } from "@/lib/agent/identity";

export async function GET() {
  const ctx = await ensureAppContext();
  const agents = listAgents(ctx);
  return NextResponse.json({ agents });
}
