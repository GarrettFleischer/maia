/**
 * @fileoverview Record approval or denial for a tool.
 * @module app/api/approvals/route
 *
 * POST /api/approvals — body: { agentId, toolName, approved: boolean }. 200 + { ok: true }.
 */

import { openDb } from "@/db/client";
import { createPermissionsRepository } from "@/db/permissions";
import { requireApiKey } from "@/lib/auth";
import { createContainer } from "@/lib/container";
import { NextResponse } from "next/server";

export async function POST(request: Request): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  let body: { agentId?: string; toolName?: string; approved?: boolean };
  try {
    body = (await request.json()) as { agentId?: string; toolName?: string; approved?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const toolName = typeof body.toolName === "string" ? body.toolName.trim() : "";
  const approved = body.approved === true;
  if (!agentId || !toolName) {
    return NextResponse.json({ error: "agentId and toolName required" }, { status: 400 });
  }
  const db = await openDb(createContainer().dbPath);
  try {
    const repo = createPermissionsRepository(db);
    await repo.record(agentId, toolName, approved);
    return NextResponse.json({ ok: true });
  } finally {
    db.close();
  }
}
