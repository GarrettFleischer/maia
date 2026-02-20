import { NextRequest } from "next/server";
import { z } from "zod";
import { runAgent } from "@/lib/agent/runner";
import {
  createSession,
  getActiveSessionId,
  setActiveSessionId,
} from "@/lib/history";
import type { SSEEvent } from "@/lib/types";

// Ensure messaging service is wired up
import "@/lib/messaging-service";

const bodySchema = z.object({
  message: z.string(),
  sessionId: z.string().optional(),
  targetAgent: z.string().optional(),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
  }

  const agentId = body.targetAgent ?? "maia";

  // Resolve session
  let sessionId = body.sessionId ?? getActiveSessionId();
  if (!sessionId) {
    sessionId = createSession(["user", agentId]);
    setActiveSessionId(sessionId);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      function send(event: SSEEvent) {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(data));
      }

      try {
        await runAgent(agentId, sessionId!, body.message, send);
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
