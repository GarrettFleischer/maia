/**
 * @fileoverview Human-readable cron schedule descriptions and next-run calculation.
 * @module lib/cron/describe
 */
import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";

/**
 * Returns a human-readable description of a 5-field cron expression.
 * @param expression - Standard 5-field cron (minute hour day month dayOfWeek)
 * @returns Description string, or "Invalid schedule" if expression is invalid
 * @example
 * describeCronSchedule('*\/5 * * * *') // "Every 5 minutes"
 * describeCronSchedule('0 9 * * *')   // "At 09:00"
 */
export function describeCronSchedule(expression: string): string {
  try {
    return cronstrue.toString(expression);
  } catch {
    return "Invalid schedule";
  }
}

/**
 * Returns the next run time for a cron expression as an ISO string, or null if invalid.
 * Uses current server time; 5-field expressions are supported (second defaults to 0).
 * @param expression - Standard 5-field cron expression
 * @param fromDate - Optional start date (defaults to now)
 * @returns ISO date string of next run, or null
 */
export function getNextCronRun(
  expression: string,
  fromDate?: Date
): string | null {
  try {
    const cron = CronExpressionParser.parse(expression, {
      currentDate: fromDate ?? new Date(),
    });
    const next = cron.next();
    const iso = next.toISOString();
    return iso ?? next.toDate().toISOString();
  } catch {
    return null;
  }
}
