/**
 * @fileoverview POST /api/chat/question-response — submit user answers for an agent's ask_user tool.
 * Resolves the pending question so the agent receives the answers and continues.
 * @module app/api/chat/question-response/route
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveQuestion } from "@/lib/question-service";

const bodySchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  answers: z.record(z.string(), z.string()),
});

/**
 * Submit answers for a pending ask_user question.
 * @brief POST with { sessionId, requestId, answers }. Resolves the question; agent receives result and continues.
 * @returns 200 on success, 400 on invalid body.
 */
export async function POST(req: NextRequest) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  resolveQuestion(body.requestId, { answers: body.answers });
  return NextResponse.json({ ok: true });
}
