/**
 * @fileoverview Shared quick-pick cron presets for schedule UI (create + edit).
 * @module lib/cron/schedule-presets
 */

export type SchedulePreset = {
  id: string;
  label: string;
  expression: string;
};

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: "15m", label: "Every 15 minutes", expression: "*/15 * * * *" },
  { id: "30m", label: "Every 30 minutes", expression: "*/30 * * * *" },
  { id: "hourly", label: "Every hour", expression: "0 * * * *" },
  { id: "daily9", label: "Daily at 9:00", expression: "0 9 * * *" },
  { id: "weekday9", label: "Weekdays at 9:00", expression: "0 9 * * 1-5" },
  { id: "weeklyMon9", label: "Monday 9:00", expression: "0 9 * * 1" },
];

/**
 * Normalizes a 5-field cron string for comparison to preset expressions.
 */
export function normalizeCronExpression(expression: string): string {
  return expression.trim().replace(/\s+/g, " ");
}

/**
 * Returns the preset id whose expression equals the given cron after normalization,
 * or undefined if no preset matches.
 */
export function matchExpressionToPresetId(
  expression: string,
  presets: readonly SchedulePreset[] = SCHEDULE_PRESETS,
): string | undefined {
  const norm = normalizeCronExpression(expression);
  return presets.find((p) => normalizeCronExpression(p.expression) === norm)?.id;
}
