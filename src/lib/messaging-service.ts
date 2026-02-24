/**
 * @fileoverview Initializes the messaging service: message_to_user (agent→user) and message_send (agent→agent with request-response).
 * When agents message each other, the recipient is run with their own system prompt and context; the message body is only who sent it and the request.
 * @module lib/messaging-service
 */
import type { AppContext } from "./context";
import { appendEntry, createSession, getActiveSessionId, listSessions } from "./history";
import { registerMessagingImpls } from "./tools/messaging";
import { getAgentIdentity } from "./agent/identity";

/**
 * Formats the user message passed to the recipient agent: sender name/id and content only.
 * The recipient receives their own system prompt and context when the runner invokes them.
 * @param senderName - Display name of the sending agent
 * @param senderId - Id of the sending agent
 * @param content - The message content
 * @returns Formatted string to pass as the user message to the recipient agent
 */
function formatMessageToRecipient(senderName: string, senderId: string, content: string): string {
  return `Message from **${senderName}** (agent id: \`${senderId}\`):\n\n${content}`;
}

/** Options for runAgentFn (e.g. emit history entries so the client receives them via EventSource). */
export type RunAgentFnOptions = { emitHistoryEntries?: boolean };

/**
 * Registers implementations for message_to_user and message_send with the tool layer.
 * @param ctx Application context
 * @param runAgentFn Runs an agent and returns its final reply text. Optional second argument can set emitHistoryEntries for background runs.
 */
export function initMessagingService(
  ctx: AppContext,
  runAgentFn: (
    ctx: AppContext,
    agentId: string,
    sessionId: string,
    message: string,
    options?: RunAgentFnOptions,
  ) => Promise<string>,
): void {
  registerMessagingImpls(
    // message_to_user
    async (agentId: string, sessionId: string, content: string) => {
      const entry = appendEntry(ctx, sessionId, {
        role: "agent",
        content,
        timestamp: new Date().toISOString(),
      });

      // Add agent to session participants if not present
      const row = ctx.db.prepare("SELECT participants FROM sessions WHERE id = ?").get(sessionId) as
        | { participants: string }
        | undefined;
      if (row) {
        const parts: string[] = JSON.parse(row.participants);
        if (!parts.includes(agentId)) {
          parts.push(agentId);
          ctx.db.prepare("UPDATE sessions SET participants = ?, updated_at = ? WHERE id = ?").run(
            JSON.stringify(parts),
            new Date().toISOString(),
            sessionId
          );
        }
      }

      ctx.events.emit({
        event: "message",
        data: {
          sessionId,
          entry,
          participants: row ? JSON.parse(row.participants) : [agentId],
        },
      });
    },

    // message_send (agent → agent): run recipient in background; when done, run caller in callerSession with reply so they can review and report
    async (fromAgentId: string, toAgentId: string, content: string, callerSessionId: string) => {
      // Find or create agent-to-agent session (separate thread for the other agent)
      const all = listSessions(ctx, "agents");
      const existingSession = all.find((s) => {
        const p = s.participants;
        return (
          p.length === 2 &&
          p.includes(fromAgentId) &&
          p.includes(toAgentId)
        );
      });

      let sessionId: string;
      if (existingSession) {
        sessionId = existingSession.id;
      } else {
        sessionId = createSession(ctx, [fromAgentId, toAgentId], "agents");
      }

      const entry = appendEntry(ctx, sessionId, {
        role: "agent",
        content: `[from:${fromAgentId}] ${content}`,
        timestamp: new Date().toISOString(),
      });

      ctx.events.emit({
        event: "message",
        data: { sessionId, entry, participants: [fromAgentId, toAgentId] },
      });

      const sender = getAgentIdentity(ctx, fromAgentId);
      const messageToRecipient =
        sender !== null
          ? formatMessageToRecipient(sender.name, sender.id, content)
          : `[from:${fromAgentId}] ${content}`;

      // Run recipient in background; when done, run caller in user session with the reply so they can review and report
      void runAgentFn(ctx, toAgentId, sessionId, messageToRecipient)
        .catch((err) => {
          console.error("message_send runAgentFn error:", err);
          return "";
        })
        .then((reply) => {
          const syntheticMessage =
            reply && reply.trim().length > 0
              ? `Agent ${toAgentId} has replied:\n\n${reply.trim()}\n\nPlease review and report to the user if needed.`
              : `Agent ${toAgentId} finished with no reply. Please report to the user.`;
          void runAgentFn(ctx, fromAgentId, callerSessionId, syntheticMessage, {
            emitHistoryEntries: true,
          }).catch((err) => console.error("message_send follow-up runAgentFn error:", err));
        });

      return "Message sent. They're working on it in a separate thread; when they reply you'll be run again here to review and report to the user.";
    }
  );
}
