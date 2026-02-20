/**
 * @fileoverview Next.js instrumentation: runs once per server cold boot. Starts the heartbeat timer scheduler in Node.js.
 * @module instrumentation
 *
 * The heartbeat scheduler restores agent_timers from the DB and runs a heartbeat when each timer fires.
 * Without this, timer-based heartbeats never run (only manual POST /api/heartbeat/tick does).
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startHeartbeatScheduler } = await import("./instrumentation-node");
  await startHeartbeatScheduler();
}
