/**
 * @fileoverview Get or create the user_chat conversation for an agent.
 * @module app/api/agents/[id]/user-chat/route
 *
 * GET /api/agents/[id]/user-chat — 200 + { id }. Creates user_chat if it does not exist.
 */

import { createConversationRepository } from "@/db/conversations";
import { openDb } from "@/db/client";
import { requireApiKey } from "@/lib/auth";
import { createContainer } from "@/lib/container";
import { NextResponse } from "next/server";

/**
 * @brief Get or create the single user_chat conversation for the agent.
 * @param request - Incoming request (Bearer auth required).
 * @param context - Route params with agent id.
 * @returns 200 JSON { id: string } (conversation id).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  const { id: agentId } = await context.params;
  const db = await openDb(createContainer().dbPath);
  try {
    const repo = createConversationRepository(db);
    const id = await repo.getOrCreate(agentId, "user_chat", null);
    return NextResponse.json({ id });
  } finally {
    db.close();
  }
}
