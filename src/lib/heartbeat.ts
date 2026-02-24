/**
 * @fileoverview In-process heartbeat: wakes all active agents on a schedule and via POST /api/cron/heartbeat.
 * @module lib/heartbeat
 */
import type { AppContext } from "./context";
import { listAgents } from "./agent/identity";
import { getSettings } from "./settings";
import { createSession } from "./history";

const HEARTBEAT_MESSAGE = `[HEARTBEAT] Timestamp: {{TIMESTAMP}}

Review your GOALS.md. Identify any tasks you can make progress on right now.
Check your MEMORY.md for relevant context.
If you need to collaborate with another agent, use the messaging tool.
Update your identity files with any new information.
Take meaningful action or report any blockers.`;

export async function fireHeartbeat(
  ctx: AppContext,
  runAgentFn: (ctx: AppContext, agentId: string, sessionId: string, message: string) => Promise<void>
): Promise<void> {
  const timestamp = new Date().toISOString();
  const message = HEARTBEAT_MESSAGE.replace("{{TIMESTAMP}}", timestamp);

  ctx.events.emit({ event: "heartbeat", data: { timestamp } });

  const agents = listAgents(ctx);
  for (const agent of agents) {
    if (agent.status !== "active") continue;

    // Each heartbeat gets its own ephemeral session
    const sessionId = createSession(ctx, [agent.id], "agents");

    runAgentFn(ctx, agent.id, sessionId, message).catch((err) => {
      console.error(`Heartbeat failed for agent ${agent.id}:`, err);
    });
  }
}

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Returns whether the in-process heartbeat scheduler is currently running.
 * @returns true if startHeartbeatScheduler has been called and not yet stopped
 */
export function isHeartbeatSchedulerRunning(): boolean {
  return _heartbeatTimer !== null;
}

export function startHeartbeatScheduler(
  ctx: AppContext,
  runAgentFn: (ctx: AppContext, agentId: string, sessionId: string, message: string) => Promise<void>
): void {
  if (_heartbeatTimer) return;
  const settings = getSettings(ctx);
  const intervalMs = settings.heartbeatIntervalMinutes * 60 * 1000;
  _heartbeatTimer = setInterval(() => {
    fireHeartbeat(ctx, runAgentFn).catch(console.error);
  }, intervalMs);
  console.log(`Heartbeat scheduler started (every ${settings.heartbeatIntervalMinutes} min)`);
}

export function stopHeartbeatScheduler(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}
