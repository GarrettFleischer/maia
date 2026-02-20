/**
 * @fileoverview Server-Sent Events for conversation updates. Subscribe by conversationId
 * to receive push events when new messages are added (heartbeat monologue, send, etc.).
 * Sends a keepalive comment every 15s to keep the stream active and help avoid buffering.
 * @module app/api/events/route
 *
 * GET /api/events?conversationId=<id>&token=<API_KEY> — streams SSE; EventSource cannot
 * send Authorization header, so token is passed in query. Returns 401 if token invalid.
 */

import { subscribe } from "@/lib/conversation-events";
import { requireApiKeyOrQuery } from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const err = requireApiKeyOrQuery(request, process.env.MAIA_API_KEY ?? "");
  if (err) return err;

  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId")?.trim();
  if (!conversationId) {
    return NextResponse.json(
      { error: "conversationId query param required" },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const KEEPALIVE_MS = 15_000;
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // client may have disconnected
        }
      };
      const unsub = subscribe(conversationId, () => {
        send("data: " + JSON.stringify({ conversationId, updated: true }) + "\n\n");
      });
      const keepalive = setInterval(() => {
        send(": keepalive\n\n");
      }, KEEPALIVE_MS);
      request.signal?.addEventListener("abort", () => {
        clearInterval(keepalive);
        unsub();
        try {
          controller.close();
        } catch {
          // ignore
        }
      });
      send(": connected\n\n");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
