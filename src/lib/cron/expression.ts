/**
 * @fileoverview Helpers for cron expressions and built-in job IDs.
 * @module lib/cron/expression
 */

/** Job id for the built-in heartbeat cron job in cron_jobs. */
export const BUILTIN_HEARTBEAT_JOB_ID = "builtin-heartbeat";

/** Prefix for system-managed per-agent run jobs (id = prefix + agent_id). */
export const AGENT_RUN_JOB_ID_PREFIX = "agent-run-";

/**
 * Converts an interval in minutes to a 5-field cron expression (every N minutes).
 * @param minutes - Interval in minutes (clamped to 1–60)
 * @returns Cron expression e.g. every 30 min or hourly for 60
 * @note For 60 minutes returns "0 * * * *" (every hour at minute 0).
 */
export function minutesToCronExpression(minutes: number): string {
  const n = Math.max(1, Math.min(60, Math.floor(minutes)));
  return n === 60 ? "0 * * * *" : `*/${n} * * * *`;
}

/**
 * Returns a staggered cron expression for a per-agent run job so agents do not overlap.
 * Spreads agents over the interval (e.g. 0, 10, 20 for 3 agents with 30-min interval).
 * @param intervalMinutes - Heartbeat interval in minutes (e.g. 30)
 * @param agentIndex - 0-based index of this agent among active non-Maia agents
 * @param totalAgents - Total count of active non-Maia agents
 * @returns 5-field cron expression e.g. "10,40 * * * *"
 */
export function staggeredAgentRunCronExpression(
  intervalMinutes: number,
  agentIndex: number,
  totalAgents: number
): string {
  const interval = Math.max(1, Math.min(60, Math.floor(intervalMinutes)));
  const n = Math.max(1, totalAgents);
  const slot = Math.floor((agentIndex / n) * interval);
  const minute1 = slot % 60;
  const minute2 = (minute1 + interval) % 60;
  if (minute1 === minute2) return `${minute1} * * * *`;
  return `${minute1},${minute2} * * * *`;
}
