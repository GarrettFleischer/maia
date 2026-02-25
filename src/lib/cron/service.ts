/**
 * @fileoverview In-process cron job scheduler: loads jobs from cron_jobs table,
 * registers them with node-cron, and runs agent messages when they fire.
 * @module lib/cron/service
 */
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import type { AppContext } from "../context";
import { createSession } from "../history";

export type RunAgentFn = (
  ctx: AppContext,
  agentId: string,
  sessionId: string,
  message: string
) => Promise<void>;

export interface CronSchedulerOptions {
  /**
   * When true, each scheduled job runs once immediately after registration (for testing).
   * @default false
   */
  runOnInit?: boolean;
}

let _tasks: ScheduledTask[] = [];
let _started = false;

/**
 * Returns whether the cron scheduler is currently running.
 * @returns true if startCronScheduler has been called and not yet stopped
 */
export function isCronSchedulerRunning(): boolean {
  return _started;
}

/**
 * Loads all rows from cron_jobs, registers each with node-cron, and runs them on schedule.
 * When a job fires, creates a session for the owning agent and invokes runAgentFn with a [CRON] message.
 * @param ctx - Application context (db, events)
 * @param runAgentFn - Called with (ctx, agentId, sessionId, message) when a job fires
 * @param options - Optional; use runOnInit: true in tests to fire handlers once immediately
 */
export function startCronScheduler(
  ctx: AppContext,
  runAgentFn: RunAgentFn,
  options: CronSchedulerOptions = {}
): void {
  if (_started) return;
  _started = true;

  const runOnInit = options.runOnInit ?? false;
  const rows = ctx.db
    .prepare("SELECT id, expression, task_description, agent_id FROM cron_jobs ORDER BY created_at")
    .all() as { id: string; expression: string; task_description: string; agent_id: string }[];

  for (const row of rows) {
    const { id: jobId, expression, task_description: taskDescription, agent_id: agentId } = row;
    if (!cron.validate(expression)) {
      console.error(`CronService: invalid expression for job ${jobId}, skipping: ${expression}`);
      continue;
    }
    let task: ScheduledTask;
    try {
      task = cron.schedule(
      expression,
      () => {
        const timestamp = new Date().toISOString();
        const message = `[CRON] Timestamp: ${timestamp}\n\n${taskDescription}`;
        const sessionId = createSession(ctx, [agentId], "agents");
        ctx.events.emit({
          event: "cron_fired",
          data: { jobId, agentId, timestamp },
        });
        runAgentFn(ctx, agentId, sessionId, message).catch((err) => {
          console.error(`Cron job ${jobId} failed for agent ${agentId}:`, err);
        });
      },
      {}
    );
    } catch (err) {
      console.error(`CronService: failed to schedule job ${jobId}:`, err);
      continue;
    }
    _tasks.push(task);
    if (runOnInit && typeof (task as { execute?: () => Promise<unknown> }).execute === "function") {
      (task as { execute: () => Promise<unknown> })
        .execute()
        .catch((err: unknown) => console.error(`CronService: runOnInit failed for ${jobId}:`, err));
    }
  }

  if (rows.length > 0) {
    console.log(`Cron scheduler started (${rows.length} job(s))`);
  }
}

/**
 * Stops all scheduled cron tasks and clears internal state.
 * @note Safe to call when not running (no-op).
 */
export function stopCronScheduler(): void {
  for (const task of _tasks) {
    task.stop();
  }
  _tasks = [];
  _started = false;
}
