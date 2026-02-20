/**
 * @fileoverview Security violations for an agent.
 * @module app/api/agents/[id]/violations/route
 *
 * GET /api/agents/[id]/violations — 200 + JSON array of violations.
 */

import { openDb } from "@/db/client";
import { createSecurityViolationsRepository } from "@/db/security-violations";
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
    const repo = createSecurityViolationsRepository(db);
    const list = await repo.listByAgent(agentId);
    return NextResponse.json(list);
  } finally {
    db.close();
  }
}
