import { NextRequest } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/instrumentation";
import { runAgent } from "@/lib/agent/runner";
import { createProvider } from "@/lib/ai/factory";
import {
  createSession,
  getActiveSessionId,
  setActiveSessionId,
} from "@/lib/history";
import type { SSEEvent } from "@/lib/types";

const bodySchema = z.object({
  message: z.string(),
  sessionId: z.string().optional(),
  targetAgent: z.string().optional(),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const ctx = getAppContext();
  const agentId = body.targetAgent ?? "maia";

  // Resolve session
  let sessionId = body.sessionId ?? getActiveSessionId(ctx);
  if (!sessionId) {
    sessionId = createSession(ctx, ["user", agentId]);
    setActiveSessionId(ctx, sessionId);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      function send(event: SSEEvent) {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(data));
      }

      try {
        await runAgent(ctx, createProvider, agentId, sessionId!, body.message, send);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
