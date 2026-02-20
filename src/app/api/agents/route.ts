/**
 * @fileoverview Agents API: list and create.
 * @module app/api/agents/route
 *
 * GET /api/agents — list all agents. 200 + JSON array.
 * POST /api/agents — create agent. Body: { name, purpose, model? }. 201 + JSON agent.
 */

import { createAgentRepository } from "@/db/agents";
import { openDb } from "@/db/client";
import { requireApiKey } from "@/lib/auth";
import { createContainer } from "@/lib/container";
import { NextResponse } from "next/server";
import fs from "node:fs";

async function getDb() {
  const container = createContainer();
  return openDb(container.dbPath);
}

/**
 * GET /api/agents
 * @returns 200 with JSON array of agents
 */
export async function GET(request: Request): Promise<NextResponse | Response> {
  const apiKey = process.env.MAIA_API_KEY ?? "";
  const err = requireApiKey(request, apiKey);
  if (err) return err;
  const db = await getDb();
  try {
    const container = createContainer();
    const repo = createAgentRepository(db, container.sandboxRoot, {
      mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    });
    const list = await repo.list();
    return NextResponse.json(list.map((a) => ({ ...a, enabled: a.enabled === 1 })), { status: 200 });
  } finally {
    db.close();
  }
}

/**
 * POST /api/agents
 * @returns 201 with created agent or 400 if body invalid
 */
export async function POST(request: Request): Promise<NextResponse | Response> {
  const apiKey = process.env.MAIA_API_KEY ?? "";
  const err = requireApiKey(request, apiKey);
  if (err) return err;
  let body: { name?: string; purpose?: string; model?: string | null };
  try {
    body = (await request.json()) as { name?: string; purpose?: string; model?: string | null };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const purpose = typeof body.purpose === "string" ? body.purpose.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  const db = await getDb();
  try {
    const container = createContainer();
    const repo = createAgentRepository(db, container.sandboxRoot, {
      mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
    });
    const agent = await repo.create({ name, purpose, model: body.model ?? null });
    return NextResponse.json(
      { ...agent, enabled: agent.enabled === 1 },
      { status: 201 }
    );
  } finally {
    db.close();
  }
}
