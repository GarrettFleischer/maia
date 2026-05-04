/**
 * @fileoverview Messaging: `message_send` to `user` appends to the active session; to `maia`, a persona id, or another
 * agent id runs the recipient in the **same** session so the unified transcript shows all voices.
 * @module lib/messaging-service
 */
import type { AppContext } from "./context";
import { appendEntry } from "./history";
import { registerMessagingImpls } from "./tools/messaging";
import { getAgentIdentity, normalizeReasoningEffort } from "./agent/identity";
import type { RunAgentFn } from "./agent/runner";
import { enqueue } from "./queue/llm-queue";
import { getPersonaById } from "./personas/registry";
import { getSettings } from "./settings";

/**
 * Formats the user message passed to the recipient: sender name/id and content only.
 */
function formatMessageToRecipient(
  senderName: string,
  senderId: string,
  content: string,
): string {
  return `Message from **${senderName}** (\`${senderId}\`):\n\n${content}`;
}

/**
 * Registers implementations for message_send (user and non-user targets) with the tool layer.
 * @param ctx Application context
 * @param runAgentFn Runs an agent and returns its final reply text.
 */
export function initMessagingService(
  ctx: AppContext,
  runAgentFn: RunAgentFn,
): void {
  const messageToUserImpl = async (
    agentId: string,
    sessionId: string,
    content: string,
  ) => {
    const identity = getAgentIdentity(ctx, agentId);
    const speakerId = identity?.id ?? agentId;
    const speakerLabel = identity?.name ?? agentId;
    const entry = appendEntry(ctx, sessionId, {
      role: "agent",
      content,
      timestamp: new Date().toISOString(),
      speakerId,
      speakerLabel,
    });

    const row = ctx.db
      .prepare("SELECT participants FROM sessions WHERE id = ?")
      .get(sessionId) as { participants: string } | undefined;
    if (row) {
      const parts: string[] = JSON.parse(row.participants);
      if (!parts.includes(speakerId)) {
        parts.push(speakerId);
        ctx.db
          .prepare(
            "UPDATE sessions SET participants = ?, updated_at = ? WHERE id = ?",
          )
          .run(JSON.stringify(parts), new Date().toISOString(), sessionId);
      }
    }

    ctx.events.emit({
      event: "message",
      data: {
        sessionId,
        entry,
        participants: row ? JSON.parse(row.participants) : [speakerId],
      },
    });
  };

  registerMessagingImpls(
    messageToUserImpl,

    async (
      fromAgentId: string,
      toTarget: string,
      content: string,
      callerSessionId: string,
    ) => {
      const sender = getAgentIdentity(ctx, fromAgentId);
      const senderName = sender?.name ?? fromAgentId;
      const messageBody = formatMessageToRecipient(senderName, fromAgentId, content);

      const persona = getPersonaById(toTarget);
      const settings = getSettings(ctx);
      const pickModel = (): string => {
        const maia = getAgentIdentity(ctx, "maia");
        if (
          maia &&
          settings.whitelistedModels.includes(maia.model)
        ) {
          return maia.model;
        }
        const first = settings.whitelistedModels[0];
        if (first) return first;
        return "openrouter/free";
      };

      if (persona) {
        const model = pickModel();
        if (!settings.whitelistedModels.includes(model)) {
          return `Cannot message persona: no whitelisted model.`;
        }
        void enqueue(
          {
            tool: "runAgent",
            args: {
              agentId: "maia",
              sessionId: callerSessionId,
              message: messageBody,
              options: {
                emitHistoryEntries: true,
                personaTurn: {
                  id: persona.id,
                  name: persona.name,
                  instructions: persona.instructions,
                  model,
                  reasoningEffort: normalizeReasoningEffort(
                    persona.suggestedReasoningEffort ?? "medium",
                  ),
                },
                queueCaller: "agent",
                smartContextViaQueue: false,
              },
              queueCaller: "agent",
              callerAgentId: fromAgentId,
              runAgentFn,
            },
            caller: "agent",
            callerAgentId: fromAgentId,
          },
          () => ctx,
        ).catch((err) => console.error("message_send persona runAgent error:", err));
        return "Message queued for persona; they will reply in this thread.";
      }

      const targetAgent = getAgentIdentity(ctx, toTarget);
      if (targetAgent) {
        void enqueue(
          {
            tool: "runAgent",
            args: {
              agentId: toTarget,
              sessionId: callerSessionId,
              message: messageBody,
              options: {
                emitHistoryEntries: true,
                queueCaller: "agent",
                smartContextViaQueue: false,
              },
              queueCaller: "agent",
              callerAgentId: fromAgentId,
              runAgentFn,
            },
            caller: "agent",
            callerAgentId: fromAgentId,
          },
          () => ctx,
        ).catch((err) => console.error("message_send runAgent error:", err));
        return "Message queued; recipient will reply in this thread.";
      }

      return `Unknown message target: ${toTarget}. Use 'user', 'maia', or a persona id from persona_list.`;
    },
  );
}
