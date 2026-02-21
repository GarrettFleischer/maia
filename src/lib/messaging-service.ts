import type { AppContext } from "./context";
import { appendEntry, createSession, getActiveSessionId, listSessions } from "./history";
import { registerMessagingImpls } from "./tools/messaging";

export function initMessagingService(
  ctx: AppContext,
  runAgentFn: (ctx: AppContext, agentId: string, sessionId: string, message: string) => Promise<void>
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

    // message_send (agent → agent)
    async (fromAgentId: string, toAgentId: string, content: string) => {
      // Find or create agent-to-agent session
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

      // Queue target agent to respond — fire and forget
      runAgentFn(ctx, toAgentId, sessionId, content).catch(console.error);
    }
  );
}
