import { NextRequest, NextResponse } from "next/server";
import { getAppContext } from "@/instrumentation";
import { getAgentIdentity } from "@/lib/agent/identity";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = getAppContext();
  const { id } = await params;
  const data = getAgentIdentity(ctx, id);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { soul, memory, goals, user, ...agent } = data;
  return NextResponse.json({ agent, soul, memory, goals, user });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = getAppContext();
  const { id } = await params;
  ctx.db.prepare("UPDATE agents SET status = 'deleted', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id
  );
  return NextResponse.json({ ok: true });
}
