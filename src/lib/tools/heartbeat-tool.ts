/**
 * @fileoverview Internal heartbeat tool: wakes Maia only so she can review the task board and message agents.
 * @module lib/tools/heartbeat-tool
 *
 * This tool is NOT visible to agents. It is invoked by the heartbeat scheduler when the timer fires.
 * Only the "maia" agent is woken (single thread). Maia is prompted to review tasks and use the
 * messaging tool to assign work and nudge other agents.
 */
import { z } from "zod";
import type { AppContext } from "../context";
import type { ToolContext } from "./types";
import type { Tool } from "./types";
import { getAgentIdentity } from "../agent/identity";
import { createSession } from "../history";
import { runDataBackup } from "../data-backup";

/** Agent id for the orchestrator that receives the single heartbeat thread. */
const MAIA_AGENT_ID = "maia";

const HEARTBEAT_BASE_MAIA = `[HEARTBEAT] Timestamp: {{TIMESTAMP}}

Review the task board below. Assign unassigned tasks to agents using task_update with assignedTo.
Message agents (using the messaging tool) to nudge them on in-progress tasks or to pick up new work.
Check your MEMORY.md for relevant context. Update your identity files with any new information.
Take meaningful action or report any blockers.`;

/**
 * Builds the task board section for Maia (unassigned and in-progress tasks).
 * @param ctx - Application context
 * @returns Task board markdown or empty string if no tasks
 */
function buildTaskBoardSection(ctx: AppContext): string {
  try {
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
  } catch {
    return "";
  }
}

function buildHeartbeatMessage(ctx: AppContext, timestamp: string): string {
  const base = HEARTBEAT_BASE_MAIA.replace("{{TIMESTAMP}}", timestamp);
  return base + buildTaskBoardSection(ctx);
}

/** RunAgentFn type for the heartbeat tool (same as cron service). */
export type HeartbeatRunAgentFn = (
  ctx: AppContext,
  agentId: string,
  sessionId: string,
  message: string,
  options?: { initialToolCall?: { name: string; args: Record<string, unknown> } }
) => Promise<void>;

/**
 * Creates the internal heartbeat tool. Not registered for agents; invoked by the heartbeat scheduler.
 * Wakes only Maia; Maia reviews the task board and messages other agents as needed.
 * @param runAgentFn - Used to run Maia with the heartbeat message (single thread).
 * @returns Tool instance (do not add to TOOL_REGISTRY).
 */
export function createHeartbeatTool(runAgentFn: HeartbeatRunAgentFn): Tool {
  return {
    name: "heartbeat",
    description: "Internal: wake Maia so she can review the task board and message agents.",
    schema: z.object({}),
    toDefinition: () => ({ name: "heartbeat", description: "", parameters: {} }),
    execute: async (_args, ctx: ToolContext) => {
      const timestamp = new Date().toISOString();
      console.debug("[Heartbeat] Tool executing", { timestamp });
      ctx.events.emit({ event: "heartbeat", data: { timestamp } });

      const maia = getAgentIdentity(ctx, MAIA_AGENT_ID);
      if (!maia || maia.status === "paused" || maia.status === "deleted") {
        console.debug("[Heartbeat] Maia not present or not active, skipping wake");
        try {
          await runDataBackup(ctx);
        } catch (err) {
          console.error("Data backup failed during heartbeat:", err);
        }
        return { woken: 0, timestamp };
      }

      const message = buildHeartbeatMessage(ctx, timestamp);
      const sessionId = createSession(ctx, [MAIA_AGENT_ID], "agents");
      await runAgentFn(ctx, MAIA_AGENT_ID, sessionId, message).catch((err) => {
        console.error("Heartbeat failed for maia:", err);
      });

      try {
        await runDataBackup(ctx);
      } catch (err) {
        console.error("Data backup failed during heartbeat:", err);
      }

      return { woken: 1, timestamp };
    },
  };
}
