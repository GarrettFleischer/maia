/**
 * @fileoverview Heartbeat: runs the internal heartbeat tool via the built-in cron job and POST /api/cron/heartbeat.
 * @module lib/heartbeat
 *
 * The heartbeat tool (not visible to agents) wakes only Maia in a single thread. Maia reviews the
 * task board and messages other agents as needed. Scheduling is done by the cron service
 * (builtin-heartbeat job in cron_jobs).
 */
import path from "path";
import type { AppContext } from "./context";
import { getWorkspaceRoot } from "./data-dir";
import { createHeartbeatTool } from "./tools/heartbeat-tool";
import type { HeartbeatRunAgentFn } from "./tools/heartbeat-tool";

/**
 * Invokes the internal heartbeat tool: wakes all active agents (in_progress first), prompts them
 * to work on tasks, and runs data backup. Used by the built-in cron job and by POST /api/cron/heartbeat.
 * @param ctx - Application context
 * @param runAgentFn - Used to run each woken agent (same signature as cron RunAgentFn)
 */
export async function fireHeartbeat(
  ctx: AppContext,
  runAgentFn: HeartbeatRunAgentFn
): Promise<void> {
  const triggeredAt = new Date().toISOString();
  console.debug("[Heartbeat] fireHeartbeat invoked", { triggeredAt });
  const tool = createHeartbeatTool(runAgentFn);
  const toolContext = {
    ...ctx,
    agentId: "system",
    sessionId: "",
    volumeRoot: path.join(getWorkspaceRoot(), "system"),
  };
  await tool.execute({}, toolContext);
}
