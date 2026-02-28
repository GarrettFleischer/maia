/**
 * @fileoverview POST /api/chat — streamed agent chat. Ensures messaging service is initialized so message_to_user and message_send work.
 * @module app/api/chat/route
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ensureAppContext } from "@/instrumentation";
import { runAgent } from "@/lib/agent/runner";
import { createProvider } from "@/lib/ai/factory";
import {
  createSession,
  getActiveSessionId,
  setActiveSessionId,
} from "@/lib/history";
import { initMessagingService } from "@/lib/messaging-service";
import type { AppContext } from "@/lib/context";
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

  const ctx = await ensureAppContext();
  const agentId = body.targetAgent ?? "maia";

  // Resolve session
  const activeId = getActiveSessionId(ctx);
  let sessionId = body.sessionId ?? activeId;
  const created = !sessionId;
  if (!sessionId) {
    sessionId = createSession(ctx, ["user", agentId]);
    setActiveSessionId(ctx, sessionId);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      function send(event: SSEEvent) {
        try {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        } catch (e) {
          // Controller may already be closed (e.g. late token callback after runAgent returned).
          // No-op so we don't throw and overwrite a successful response with an error event.
          if (e instanceof Error && e.message?.includes("already closed") === true) return;
          throw e;
        }
      }

      type RunAgentOptions = { emitHistoryEntries?: boolean };
      const runAgentFn = async (
        c: AppContext,
        toAgentId: string,
        toSessionId: string,
        message: string,
        options?: RunAgentOptions,
      ) => {
        return runAgent(c, createProvider, toAgentId, toSessionId, message, () => {}, options);
      };
      initMessagingService(ctx, runAgentFn);

      try {
        // Run agent directly so the queue worker stays free to process extractSearchQueries
        // and other smart-context jobs that the agent awaits. Pass send so tokens and done
        // are streamed to the client.
        await runAgent(ctx, createProvider, agentId, sessionId!, body.message, send, {
          emitHistoryEntries: true,
          queueCaller: "user",
        });
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
