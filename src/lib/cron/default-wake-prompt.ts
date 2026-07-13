/**
 * @fileoverview Default cron user message when a job uses prompt or delegated-persona wake mode.
 * @module lib/cron/default-wake-prompt
 */

/**
 * Shipped text for `cron_jobs.cron_message` when operators choose **Wake up** (task-first
 * maintenance) for Maia or a delegated persona.
 *
 * Instructs the agent to use the task board, advance work, and propose or start new tasks
 * when broader goals are not yet satisfied.
 */
export const DEFAULT_CRON_WAKE_PROMPT = `[CRON] Scheduled wake.

**Wake up:** Review the shared task board with **task_list** / **task_get** / **task_update**.

- Continue **in_progress** work you own or should unblock; move **todo** items forward when you can.
- Add short notes when you change status or discover blockers.
- If commitments look healthy but the user’s overall goal is **not** clearly met yet, propose sensible **new** tasks (or break down existing ones) and start the highest-leverage item you can without waiting for the user.

Stay concise; prefer doing over reporting.`;
