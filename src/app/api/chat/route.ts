/**
 * @fileoverview POST /api/chat — streamed agent chat. Ensures messaging service is initialized so message_send (to user or agent) works.
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
  getSessionDefaultPersonaId,
  getSessionMeta,
  isMaiaUserThread,
  setActiveSessionId,
} from "@/lib/history";
import { initMessagingService } from "@/lib/messaging-service";
import { getAgentIdentity, normalizeReasoningEffort } from "@/lib/agent/identity";
import { getSettings } from "@/lib/settings";
import { getPersonaById } from "@/lib/personas/registry";
import { resolveCatalogPersonaForUserMessage } from "@/lib/chat/persona-target";
import type { AppContext } from "@/lib/context";
import type { SSEEvent } from "@/lib/types";
import type { RunAgentOptions } from "@/lib/agent/runner";

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

  // Resolve session (unified user threads: user + maia)
  const activeId = getActiveSessionId(ctx);
  let sessionId = body.sessionId ?? activeId;
  if (!sessionId) {
    sessionId = createSession(ctx, ["user", "maia"]);
    setActiveSessionId(ctx, sessionId);
  }

  const sessionMeta = getSessionMeta(ctx, sessionId);
  const sessionDefaultPersonaId =
    sessionMeta && isMaiaUserThread(sessionMeta.participants, sessionMeta.type)
      ? getSessionDefaultPersonaId(ctx, sessionId)
      : null;

  const { chosen: chosenPersona, mentionRest, usedLeadingMention } =
    resolveCatalogPersonaForUserMessage(getPersonaById, {
      message: body.message,
      clientTargetAgent: body.targetAgent ?? "maia",
      sessionMeta,
      sessionDefaultPersonaId,
    });

  const clientTarget = body.targetAgent?.trim() || "maia";
  let agentId: string;
  if (chosenPersona) {
    agentId = "maia";
  } else {
    agentId = clientTarget;
    if (!getAgentIdentity(ctx, agentId)) {
      return new Response(JSON.stringify({ error: `Unknown agent: ${agentId}` }), { status: 400 });
    }
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

      const settings = getSettings(ctx);
      let runMessage = body.message;
      let runOpts: RunAgentOptions = {
        emitHistoryEntries: true,
        queueCaller: "user",
      };

      if (chosenPersona) {
        const maiaModel = getAgentIdentity(ctx, "maia")?.model;
        const model =
          maiaModel && settings.whitelistedModels.includes(maiaModel)
            ? maiaModel
            : settings.whitelistedModels[0] ?? "openrouter/free";
        runMessage = usedLeadingMention
          ? mentionRest.trim() || "Please help with the user's request."
          : body.message.trim() || "Please help with the user's request.";
        runOpts = {
          ...runOpts,
          personaTurn: {
            id: chosenPersona.id,
            name: chosenPersona.name,
            instructions: chosenPersona.instructions,
            model,
            reasoningEffort: normalizeReasoningEffort(
              chosenPersona.suggestedReasoningEffort ?? "medium",
            ),
          },
        };
      }

      try {
        // Run agent directly so the queue worker stays free to process extractSearchQueries
        // and other smart-context jobs that the agent awaits. Pass send so tokens and done
        // are streamed to the client.
        await runAgent(ctx, createProvider, agentId, sessionId!, runMessage, send, runOpts);
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
