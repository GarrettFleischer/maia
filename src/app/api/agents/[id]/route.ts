/**
 * @fileoverview Single agent API: get, update, delete.
 * @module app/api/agents/[id]/route
 *
 * GET /api/agents/[id] — get agent. 200 + JSON or 404.
 * PATCH /api/agents/[id] — update (name, model, enabled). 200 + JSON or 404.
 * DELETE /api/agents/[id] — delete agent. 204 or 404.
 */

import { createAgentRepository } from "@/db/agents";
import { openDb } from "@/db/client";
import { requireApiKey } from "@/lib/auth";
import { createContainer } from "@/lib/container";
import { NextResponse } from "next/server";
import fs from "node:fs";

async function getRepos() {
  const container = createContainer();
  const db = await openDb(container.dbPath);
  const agents = createAgentRepository(db, container.sandboxRoot, {
    mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
    writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
  });
  return { db, agents };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  const { id } = await context.params;
  const { db, agents } = await getRepos();
  try {
    const agent = await agents.get(id);
    if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ...agent, enabled: agent.enabled === 1 });
  } finally {
    db.close();
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  const { id } = await context.params;
  let body: { name?: string; model?: string | null; enabled?: boolean };
  try {
    body = (await request.json()) as { name?: string; model?: string | null; enabled?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { db, agents } = await getRepos();
  try {
    const agent = await agents.get(id);
    if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const patch: { name?: string; model?: string | null; enabled?: number } = {};
    if (typeof body.name === "string") patch.name = body.name.trim();
    if (body.model !== undefined) patch.model = body.model;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled ? 1 : 0;
    await agents.update(id, patch);
    const updated = await agents.get(id);
    return NextResponse.json(updated ? { ...updated, enabled: updated.enabled === 1 } : agent);
  } finally {
    db.close();
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  const { id } = await context.params;
  const { db, agents } = await getRepos();
  try {
    const agent = await agents.get(id);
    if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await agents.delete(id);
    return new NextResponse(null, { status: 204 });
  } finally {
    db.close();
  }
}
