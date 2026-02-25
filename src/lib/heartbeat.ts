/**
 * @fileoverview In-process heartbeat: wakes all active agents on a schedule and via POST /api/cron/heartbeat.
 * @module lib/heartbeat
 */
import type { AppContext } from "./context";
import { listAgents } from "./agent/identity";
import { getSettings } from "./settings";
import { createSession } from "./history";

const HEARTBEAT_BASE = `[HEARTBEAT] Timestamp: {{TIMESTAMP}}

Review your GOALS.md. Identify any tasks you can make progress on right now.
Check your MEMORY.md for relevant context.
If you need to collaborate with another agent, use the messaging tool.
Update your identity files with any new information.
Take meaningful action or report any blockers.`;

function buildTaskBoardSection(ctx: AppContext, agentId: string): string {
  try {
    if (agentId === "maia") {
      const unassigned = ctx.db
        .prepare(
          `SELECT id, title, created_by FROM tasks WHERE status = 'todo' AND assigned_to IS NULL ORDER BY created_at ASC`
        )
        .all() as { id: string; title: string; created_by: string }[];

      const inProgress = ctx.db
        .prepare(
          `SELECT id, title, assigned_to FROM tasks WHERE status = 'in_progress' ORDER BY updated_at ASC`
        )
        .all() as { id: string; title: string; assigned_to: string | null }[];

      const lines: string[] = ["\n\n## Task Board"];

      if (unassigned.length > 0) {
        lines.push("### Unassigned Tasks (assign these to agents using task_update with assignedTo)");
        for (const t of unassigned) {
          lines.push(`- [${t.id}] ${t.title} — created by ${t.created_by}`);
        }
      }

      if (inProgress.length > 0) {
        lines.push("### In-Progress Tasks (check in with assigned agents if needed)");
        for (const t of inProgress) {
          lines.push(`- [${t.id}] ${t.title} — assigned to ${t.assigned_to ?? "unassigned"}`);
        }
      }

      if (unassigned.length === 0 && inProgress.length === 0) return "";
      return lines.join("\n");
    } else {
      const myTasks = ctx.db
        .prepare(
          `SELECT id, title, description, status FROM tasks WHERE assigned_to = ? AND status != 'done' ORDER BY updated_at ASC`
        )
        .all(agentId) as { id: string; title: string; description: string; status: string }[];

      if (myTasks.length === 0) return "";

      const lines = ["\n\n## Your Assigned Tasks"];
      for (const t of myTasks) {
        const desc = t.description ? ` — ${t.description}` : "";
        lines.push(`- [${t.id}] ${t.title} (${t.status})${desc}`);
      }
      lines.push(
        "\nUse task_update to change status or add notes as you make progress. Mark tasks as 'done' when complete."
      );
      return lines.join("\n");
    }
  } catch {
    // tasks table may not exist yet in tests or old DBs
    return "";
  }
}

function buildHeartbeatMessage(ctx: AppContext, agentId: string, timestamp: string): string {
  const base = HEARTBEAT_BASE.replace("{{TIMESTAMP}}", timestamp);
  return base + buildTaskBoardSection(ctx, agentId);
}

export async function fireHeartbeat(
  ctx: AppContext,
  runAgentFn: (ctx: AppContext, agentId: string, sessionId: string, message: string) => Promise<void>
): Promise<void> {
  const timestamp = new Date().toISOString();

  ctx.events.emit({ event: "heartbeat", data: { timestamp } });

  const agents = listAgents(ctx);
  for (const agent of agents) {
    if (agent.status !== "active") continue;

    const message = buildHeartbeatMessage(ctx, agent.id, timestamp);

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
