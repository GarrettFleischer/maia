/**
 * @fileoverview Initializes the messaging service: message_to_user (agent→user) and message_send (agent→agent with request-response).
 * When agents message each other, the recipient is run with their own system prompt and context; the message body is only who sent it and the request.
 * @module lib/messaging-service
 */
import type { AppContext } from "./context";
import { appendEntry, createSession, listSessions } from "./history";
import { registerMessagingImpls } from "./tools/messaging";
import { getAgentIdentity } from "./agent/identity";
import type { RunAgentFn } from "./agent/runner";
import { enqueue } from "./queue/llm-queue";

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

/** Strips trailing [DONE] from a reply. */
function stripDone(reply: string): string {
  return reply.replace(/\s*\[DONE\]\s*$/i, "").trim();
}

/** Returns true if the reply ends with [DONE] (case-insensitive). */
function endsWithDone(reply: string): boolean {
  return /\[DONE\]\s*$/i.test(reply.trim());
}

/** Max turns in agent-agent conversation before forcing stop (safety limit). */
const MAX_AGENT_CHAT_TURNS = 100;

/**
 * Registers implementations for message_to_user and message_send with the tool layer.
 * @param ctx Application context
 * @param runAgentFn Runs an agent and returns its final reply text. Optional second argument can set emitHistoryEntries for background runs.
 */
export function initMessagingService(
  ctx: AppContext,
  runAgentFn: RunAgentFn,
): void {
  const messageToUserImpl = async (agentId: string, sessionId: string, content: string) => {
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
  };

  registerMessagingImpls(
    messageToUserImpl,

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
        const fromName = getAgentIdentity(ctx, fromAgentId)?.name ?? fromAgentId;
        const toName = getAgentIdentity(ctx, toAgentId)?.name ?? toAgentId;
        sessionId = createSession(ctx, [fromAgentId, toAgentId], "agents", `${fromName} ↔ ${toName}`);
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

      // Run conversation loop: alternate between agents, automatically forwarding each reply to the other until one says [DONE]
      async function runConversationLoop(
        currentAgentId: string,
        message: string,
        turn: number,
      ): Promise<void> {
        if (turn >= MAX_AGENT_CHAT_TURNS) {
          console.warn(`message_send: max turns (${MAX_AGENT_CHAT_TURNS}) reached; stopping conversation`);
          return;
        }
        const reply = (await enqueue(
          {
            tool: "runAgent",
            args: {
              agentId: currentAgentId,
              sessionId,
              message,
              options: { emitHistoryEntries: true },
              queueCaller: "agent",
              runAgentFn,
            },
            caller: "agent",
            callerAgentId: fromAgentId,
          },
          () => ctx,
        ).catch((err) => {
          console.error("message_send runAgentFn error:", err);
          return "";
        })) as string;
        if (endsWithDone(reply)) {
          const stripped = stripDone(reply);
          await messageToUserImpl(
            currentAgentId,
            callerSessionId,
            stripped.length > 0 ? stripped : "(No message)",
          ).catch((err) => console.error("message_send [DONE] message_to_user error:", err));
          return;
        }
        const otherAgentId = currentAgentId === toAgentId ? fromAgentId : toAgentId;
        const replierIdentity = getAgentIdentity(ctx, currentAgentId);
        const messageToOther =
          reply && reply.trim().length > 0
            ? replierIdentity !== null
              ? formatMessageToRecipient(replierIdentity.name, replierIdentity.id, reply.trim())
              : `[from:${currentAgentId}]\n\n${reply.trim()}`
            : `[from:${currentAgentId}] (no reply)`;
        return runConversationLoop(otherAgentId, messageToOther, turn + 1);
      }

      void runConversationLoop(toAgentId, messageToRecipient, 0).catch((err) =>
        console.error("message_send conversation loop error:", err),
      );

      return "Message sent. You're chatting in a separate thread; replies are automatically forwarded between you until one of you ends with [DONE].";
    }
  );
}
