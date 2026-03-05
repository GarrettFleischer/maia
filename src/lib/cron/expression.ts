/**
 * @fileoverview Helpers for cron expressions and built-in job IDs.
 * @module lib/cron/expression
 */

/** Job id for the built-in heartbeat cron job in cron_jobs. */
export const BUILTIN_HEARTBEAT_JOB_ID = "builtin-heartbeat";

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
