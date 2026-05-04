/**
 * @fileoverview Default cron user message when a job uses prompt or delegated-persona wake mode.
 * @module lib/cron/default-wake-prompt
 */

/**
 * @brief Shipped text for `cron_jobs.cron_message` when operators omit a custom message (task-first maintenance).
 */
export const DEFAULT_CRON_WAKE_PROMPT = `[CRON] Scheduled wake.

Use **task_list** (filter **todo** and **in_progress** as needed) and **task_get** / **task_update** on the shared board: continue **in_progress** work you own or should unblock, advance **todo** items you can take, and leave short notes when you change status.

Stay focused on existing commitments; if blocked, say what blocked you briefly.`;
