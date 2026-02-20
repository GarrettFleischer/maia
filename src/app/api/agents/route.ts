import { NextResponse } from "next/server";
import { listAgents } from "@/lib/agent/identity";

export async function GET() {
  const agents = listAgents();
  return NextResponse.json({ agents });
}
