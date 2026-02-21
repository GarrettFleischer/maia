import { NextResponse } from "next/server";
import { getAppContext } from "@/instrumentation";
import { listAgents } from "@/lib/agent/identity";

export async function GET() {
  const ctx = getAppContext();
  const agents = listAgents(ctx);
  return NextResponse.json({ agents });
}
