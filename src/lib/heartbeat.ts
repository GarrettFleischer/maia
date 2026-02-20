import { emit } from "./events";
import { listAgents } from "./agent/identity";
import { getSettings } from "./settings";
import { runAgent } from "./agent/runner";
import { createSession } from "./history";

const HEARTBEAT_MESSAGE = `[HEARTBEAT] Timestamp: {{TIMESTAMP}}

Review your GOALS.md. Identify any tasks you can make progress on right now.
Check your MEMORY.md for relevant context.
If you need to collaborate with another agent, use the messaging tool.
Update your identity files with any new information.
Take meaningful action or report any blockers.`;

export async function fireHeartbeat(): Promise<void> {
  const timestamp = new Date().toISOString();
  const message = HEARTBEAT_MESSAGE.replace("{{TIMESTAMP}}", timestamp);

  emit({ event: "heartbeat", data: { timestamp } });

  const agents = listAgents();
  for (const agent of agents) {
    if (agent.status !== "active") continue;

    // Each heartbeat gets its own ephemeral session
    const sessionId = createSession([agent.id], "agents");

    runAgent(agent.id, sessionId, message, () => {}).catch((err) => {
      console.error(`Heartbeat failed for agent ${agent.id}:`, err);
    });
  }
}

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeatScheduler(): void {
  if (_heartbeatTimer) return;
  const settings = getSettings();
  const intervalMs = settings.heartbeatIntervalMinutes * 60 * 1000;
  _heartbeatTimer = setInterval(() => {
    fireHeartbeat().catch(console.error);
  }, intervalMs);
  console.log(`Heartbeat scheduler started (every ${settings.heartbeatIntervalMinutes} min)`);
}

export function stopHeartbeatScheduler(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}
