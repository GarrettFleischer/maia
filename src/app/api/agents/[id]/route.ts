/**
 * @fileoverview API route for a single agent: GET (with identity), PATCH (model/name), DELETE (soft-delete).
 * @module app/api/agents/[id]/route
 */
import { NextRequest, NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { getAgentIdentity, updateAgent } from "@/lib/agent/identity";
import { getSettings } from "@/lib/settings";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ensureAppContext();
  const { id } = await params;
  const data = getAgentIdentity(ctx, id);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { soul, memory, user, agentsMd, ...agent } = data;
  return NextResponse.json({ agent, soul, memory, user, agentsMd });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ensureAppContext();
  const { id } = await params;
  const data = getAgentIdentity(ctx, id);
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let body: {
    model?: string;
    name?: string;
    reasoningEffort?: "off" | "low" | "medium" | "high";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.model !== undefined) {
    const settings = getSettings(ctx);
    if (!settings.whitelistedModels.includes(body.model)) {
      return NextResponse.json(
        { error: `Model not whitelisted: ${body.model}` },
        { status: 400 },
      );
    }
  }
  const updated = updateAgent(ctx, id, {
    model: body.model,
    name: body.name,
    reasoningEffort: body.reasoningEffort,
  });
  if (!updated)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const updatedData = getAgentIdentity(ctx, id);
  const { soul, memory, user, agentsMd, ...agent } = updatedData!;
  return NextResponse.json({ agent });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ensureAppContext();
  const { id } = await params;
  ctx.db
    .prepare(
      "UPDATE agents SET status = 'deleted', updated_at = ? WHERE id = ?",
    )
    .run(new Date().toISOString(), id);
  return NextResponse.json({ ok: true });
}
