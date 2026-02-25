/**
 * @fileoverview Test-only API route to emit an SSE event onto the app event bus.
 * Used by E2E tests to simulate agent messages without running the real agent.
 * @module api/test/emit-event
 */

import { NextRequest } from "next/server";
import { getAppContext } from "@/instrumentation";
import type { SystemSSEEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST body shape for emitting a test event.
 * Must match one of the SystemSSEEvent variants.
 */
interface EmitEventBody {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Emit an SSE event onto the global event bus.
 * @brief Handles POST with { event, data } and forwards to ctx.events.emit().
 * @param req - Next request; body must be JSON with event and data.
 * @returns 200 on success, 400 on invalid body.
 * @example
 * POST /api/test/emit-event
 * Body: { "event": "message", "data": { "sessionId": "...", "entry": {...}, "participants": [] } }
 */
export async function POST(req: NextRequest) {
  // Only allow in test/E2E context so production never exposes this endpoint.
  const isTestEnv =
    process.env.NODE_ENV === "test" || process.env.E2E_TEST === "1";
  if (!isTestEnv) {
    return new Response(null, { status: 404 });
  }

  let body: EmitEventBody;
  try {
    const parsed = await req.json();
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.event !== "string" ||
      typeof parsed.data !== "object" ||
      parsed.data === null
    ) {
      return new Response(JSON.stringify({ error: "Invalid body: need { event: string, data: object }" }), {
        status: 400,
      });
    }
    body = { event: parsed.event, data: parsed.data as Record<string, unknown> };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const ctx = getAppContext();
  ctx.events.emit(body as SystemSSEEvent);
  return new Response(null, { status: 200 });
}
