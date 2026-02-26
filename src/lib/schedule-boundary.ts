/**
 * @fileoverview Wall-clock scheduling: delay until next boundary for interval-based jobs.
 * @module lib/schedule-boundary
 *
 * Used so cron-style jobs (heartbeat, knowledge index) fire on system time (e.g. 3:30, 4:00)
 * rather than "every N minutes since process start".
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * Returns milliseconds until the next wall-clock boundary for the given interval.
 * E.g. interval 30 → boundaries at :00 and :30; interval 60 → boundaries at :00.
 *
 * @param intervalMinutes - Interval in minutes (e.g. 30 for every half hour).
 * @param nowMs - Current time in ms since epoch (default: Date.now()); pass in tests for determinism.
 * @returns Ms to wait until next boundary; then subsequent runs every intervalMinutes.
 * @example
 * // At 3:15 with interval 30 → delay ~15 min to 3:30
 * delayUntilNextBoundaryMs(30);
 * // At 3:00 with interval 60 → delay 60 min to 4:00
 * delayUntilNextBoundaryMs(60);
 */
export function delayUntilNextBoundaryMs(
  intervalMinutes: number,
  nowMs: number = Date.now()
): number {
  const intervalMs = intervalMinutes * 60 * 1000;
  const msSinceHour = nowMs % HOUR_MS;
  const nextBoundaryOffset = (Math.floor(msSinceHour / intervalMs) + 1) * intervalMs;
  if (nextBoundaryOffset >= HOUR_MS) {
    return HOUR_MS - msSinceHour;
  }
  return nextBoundaryOffset - msSinceHour;
}
