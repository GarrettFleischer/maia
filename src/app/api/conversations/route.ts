/**
 * @fileoverview Create conversation.
 * @module app/api/conversations/route
 *
 * POST /api/conversations — body: { agentId, type, participantAgentId? }. 201 + { id }.
 */

import { createConversationRepository } from "@/db/conversations";
import { openDb } from "@/db/client";
import { requireApiKey } from "@/lib/auth";
import { createContainer } from "@/lib/container";
import { NextResponse } from "next/server";

export async function POST(request: Request): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  let body: { agentId?: string; type?: string; participantAgentId?: string | null };
  try {
    body = (await request.json()) as { agentId?: string; type?: string; participantAgentId?: string | null };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "user_chat";
  if (!agentId) return NextResponse.json({ error: "agentId required" }, { status: 400 });
  const db = await openDb(createContainer().dbPath);
  try {
    const repo = createConversationRepository(db);
    const id = await repo.create(agentId, type, body.participantAgentId ?? null);
    return NextResponse.json({ id }, { status: 201 });
  } finally {
    db.close();
  }
}
