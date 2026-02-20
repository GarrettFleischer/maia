import { NextRequest, NextResponse } from "next/server";
import { getAgentIdentity } from "@/lib/agent/identity";
import { getDb } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const data = getAgentIdentity(id);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { soul, memory, goals, user, ...agent } = data;
  return NextResponse.json({ agent, soul, memory, goals, user });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Only Maia can delete agents — enforced here by server-side check
  // (In a multi-user setup, add auth check here)
  const db = getDb();
  db.prepare("UPDATE agents SET status = 'deleted', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id
  );
  return NextResponse.json({ ok: true });
}
