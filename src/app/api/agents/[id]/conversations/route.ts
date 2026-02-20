/**
 * @fileoverview List conversations for an agent.
 * @module app/api/agents/[id]/conversations/route
 *
 * GET /api/agents/[id]/conversations — 200 + JSON array of conversations.
 */

import { createConversationRepository } from "@/db/conversations";
import { openDb } from "@/db/client";
import { requireApiKey } from "@/lib/auth";
import { createContainer } from "@/lib/container";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  const { id: agentId } = await context.params;
  const db = await openDb(createContainer().dbPath);
  try {
    const repo = createConversationRepository(db);
    await repo.getOrCreate(agentId, "internal", null);
    const list = await repo.listByAgent(agentId);
    return NextResponse.json(list);
  } finally {
    db.close();
  }
}
