/**
 * @fileoverview Heartbeat: runs the internal heartbeat tool via the built-in cron job and POST /api/cron/heartbeat.
 * @module lib/heartbeat
 *
 * The heartbeat tool (not visible to agents) wakes only Maia in a single thread. Maia reviews the
 * task board and manages cron jobs; she does not message agents. Scheduling is done by the cron service
 * (builtin-heartbeat job in cron_jobs).
 */
import path from "path";
import type { AppContext } from "./context";
import { getDataDir } from "./data-dir";
import { createHeartbeatTool } from "./tools/heartbeat-tool";
import type { RunAgentFn } from "./agent/runner";

/** Idempotency window: skip firing again if last run was within this many ms. */
const HEARTBEAT_MIN_INTERVAL_MS = 60_000;

/** Timestamp of the last heartbeat run that proceeded (used for idempotency). */
let lastHeartbeatAt = 0;

/**
 * Resets idempotency state. Only for use in tests so that a subsequent fireHeartbeat is not skipped.
 * @internal
 */
export function _resetHeartbeatIdempotencyForTests(): void {
  lastHeartbeatAt = 0;
}

/**
 * Invokes the internal heartbeat tool: wakes Maia to review tasks and manage cron jobs, then runs
 * data backup. Used by the built-in cron job and by POST /api/cron/heartbeat.
 * A second call within HEARTBEAT_MIN_INTERVAL_MS is skipped to avoid duplicate cron fires.
 * @param ctx - Application context
 * @param runAgentFn - Used to run each woken agent
 */
export async function fireHeartbeat(
  ctx: AppContext,
  runAgentFn: RunAgentFn,
): Promise<void> {
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) {
    console.debug("[Heartbeat] Heartbeat skipped, too soon since last run");
    return;
  }
  lastHeartbeatAt = now;
  const triggeredAt = new Date().toISOString();
  console.debug("[Heartbeat] fireHeartbeat invoked", { triggeredAt });
  const tool = createHeartbeatTool(runAgentFn);
  const toolContext = {
    ...ctx,
    agentId: "system",
    sessionId: "",
    volumeRoot: path.join(getDataDir(), "system"),
  };
  await tool.execute({}, toolContext);
}
