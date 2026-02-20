/**
 * @fileoverview List and append messages for a conversation.
 * @module app/api/conversations/[id]/messages/route
 *
 * GET /api/conversations/[id]/messages — 200 + JSON array of messages.
 * POST /api/conversations/[id]/messages — body: { type, content?, role?, tool_name?, tool_args?, tool_result? }. 201 + { id }.
 */

import { createConversationRepository } from "@/db/conversations";
import { createMessageRepository } from "@/db/messages";
import { openDb } from "@/db/client";
import { requireApiKey } from "@/lib/auth";
import { createContainer } from "@/lib/container";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  const { id: conversationId } = await context.params;
  const db = await openDb(createContainer().dbPath);
  try {
    const convRepo = createConversationRepository(db);
    const conv = await convRepo.get(conversationId);
    if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const msgRepo = createMessageRepository(db);
    const messages = await msgRepo.listByConversation(conversationId);
    return NextResponse.json(messages);
  } finally {
    db.close();
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse | Response> {
  const err = requireApiKey(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;
  const { id: conversationId } = await context.params;
  let body: {
    type: string;
    role?: string;
    content?: string | null;
    tool_name?: string | null;
    tool_args?: string | null;
    tool_result?: string | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.type || typeof body.type !== "string") {
    return NextResponse.json({ error: "type required" }, { status: 400 });
  }
  const db = await openDb(createContainer().dbPath);
  try {
    const convRepo = createConversationRepository(db);
    const conv = await convRepo.get(conversationId);
    if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const msgRepo = createMessageRepository(db);
    const id = randomUUID();
    await msgRepo.append(
      conversationId,
      {
        type: body.type,
        role: body.role,
        content: body.content,
        tool_name: body.tool_name,
        tool_args: body.tool_args,
        tool_result: body.tool_result,
      },
      id
    );
    return NextResponse.json({ id }, { status: 201 });
  } finally {
    db.close();
  }
}
