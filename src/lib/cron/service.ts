/**
 * @fileoverview In-process cron job scheduler: loads jobs from cron_jobs table,
 * registers them with node-cron, and runs agent messages when they fire.
 * Syncs per-agent run jobs so each active agent (except Maia) has a staggered cron job.
 * @module lib/cron/service
 */
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import type { AppContext } from "../context";
import { getOrCreateSession } from "../history";
import type { RunAgentFn } from "../agent/runner";
import { fireHeartbeat } from "../heartbeat";
import { getSettings } from "../settings";
import { enqueue } from "../queue/llm-queue";
import { listAgents } from "../agent/identity";
import {
  BUILTIN_HEARTBEAT_JOB_ID,
  AGENT_RUN_JOB_ID_PREFIX,
  minutesToCronExpression,
  staggeredAgentRunCronExpression,
} from "./expression";

export interface CronSchedulerOptions {
  /**
   * When true, each scheduled job runs once immediately after registration (for testing).
   * @default false
   */
  runOnInit?: boolean;
}

let _taskMap = new Map<string, ScheduledTask>();
let _started = false;
let _ctx: AppContext | null = null;
let _runAgentFn: RunAgentFn | null = null;

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
/**
 * Schedules a single job and adds it to _taskMap. Used by startCronScheduler and refreshHeartbeatJob.
 * @param ctx - Application context
 * @param runAgentFn - RunAgentFn to invoke when job fires
 * @param row - cron_jobs row
 * @param runOnInit - Whether to run the task once immediately
 */
function scheduleJob(
  ctx: AppContext,
  runAgentFn: RunAgentFn,
  row: {
    id: string;
    expression: string;
    task_description: string;
    agent_id: string;
    tool_name: string;
    tool_args: string;
  },
  runOnInit: boolean,
): void {
  const {
    id: jobId,
    expression,
    task_description: taskDescription,
    agent_id: agentId,
    tool_name: toolName,
    tool_args: toolArgsJson,
  } = row;

  const agentExists = ctx.db
    .prepare("SELECT 1 FROM agents WHERE id = ? AND status != 'deleted'")
    .get(agentId);
  if (!agentExists) {
    console.warn(
      `CronService: skipping job ${jobId} — target agent ${agentId} not found or deleted`,
    );
    return;
  }

  if (!cron.validate(expression)) {
    console.error(
      `CronService: invalid expression for job ${jobId}, skipping: ${expression}`,
    );
    return;
  }
  let toolArgs: Record<string, unknown> = {};
  try {
    toolArgs = toolArgsJson
      ? (JSON.parse(toolArgsJson) as Record<string, unknown>)
      : {};
  } catch {
    console.error(`CronService: invalid tool_args for job ${jobId}, using {}`);
  }
  const toolNameSafe = toolName || "cron_echo";

  const isHeartbeat = jobId === BUILTIN_HEARTBEAT_JOB_ID;
  let task: ScheduledTask;
  try {
    task = cron.schedule(
      expression,
      () => {
        const timestamp = new Date().toISOString();
        if (isHeartbeat) {
          console.debug("[Heartbeat] Cron triggered", { jobId, timestamp });
          ctx.events.emit({
            event: "cron_fired",
            data: { jobId, agentId, timestamp },
          });
          fireHeartbeat(ctx, runAgentFn).catch((err) => {
            console.error(`Cron job ${jobId} (heartbeat) failed:`, err);
          });
        } else {
          const message = "[CRON]";
          const sessionName = taskDescription.trim() || `Cron: ${jobId}`;
          const sessionId = getOrCreateSession(
            ctx,
            [agentId],
            "agents",
            sessionName,
          );
          ctx.events.emit({
            event: "cron_fired",
            data: { jobId, agentId, timestamp },
          });
          enqueue(
            {
              tool: "runAgent",
              args: {
                agentId,
                sessionId,
                message,
                options: {
                  initialToolCall: { name: toolNameSafe, args: toolArgs },
                },
                queueCaller: "agent",
                runAgentFn,
              },
              caller: "agent",
              callerAgentId: agentId,
            },
            () => ctx,
          ).catch((err) => {
            console.error(
              `Cron job ${jobId} failed for agent ${agentId}:`,
              err,
            );
          });
        }
      },
      {},
    );
  } catch (err) {
    console.error(`CronService: failed to schedule job ${jobId}:`, err);
    return;
  }
  _taskMap.set(jobId, task);
  if (
    runOnInit &&
    typeof (task as { execute?: () => Promise<unknown> }).execute === "function"
  ) {
    (task as { execute: () => Promise<unknown> })
      .execute()
      .catch((err: unknown) =>
        console.error(`CronService: runOnInit failed for ${jobId}:`, err),
      );
  }
}

/**
 * Syncs agent-run cron jobs with active agents: one staggered job per active agent (except Maia).
 * Each job wakes the agent with cron_echo and empty message; no hardcoded prompt.
 * @param ctx - Application context
 */
export function syncAgentRunJobs(ctx: AppContext): void {
  const agents = listAgents(ctx).filter(
    (a) => a.status === "active" && a.id !== "maia",
  );
  const interval = getSettings(ctx).heartbeatIntervalMinutes;

  ctx.db
    .prepare("DELETE FROM cron_jobs WHERE id LIKE ?")
    .run(AGENT_RUN_JOB_ID_PREFIX + "%");

  const now = new Date().toISOString();
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    const jobId = AGENT_RUN_JOB_ID_PREFIX + agent.id;
    const expression = staggeredAgentRunCronExpression(
      interval,
      i,
      agents.length,
    );
    const toolArgs = JSON.stringify({ msg: "" });
    ctx.db
      .prepare(
        `INSERT INTO cron_jobs (id, expression, task_description, agent_id, is_built_in, created_at, tool_name, tool_args)
       VALUES (?, ?, ?, ?, 1, ?, 'cron_echo', ?)`,
      )
      .run(jobId, expression, "Scheduled run", agent.id, now, toolArgs);
  }
}

/**
 * Reconciles in-memory scheduled tasks with cron_jobs: schedules any new agent-run jobs
 * and stops any agent-run jobs that no longer exist in the DB.
 * No-op if the cron scheduler has not been started.
 * @param ctx - Application context
 */
export function reconcileAgentRunTasks(ctx: AppContext): void {
  if (!_started || !_ctx || !_runAgentFn) return;

  const rows = ctx.db
    .prepare(
      "SELECT id, expression, task_description, agent_id, tool_name, tool_args FROM cron_jobs WHERE id LIKE ?",
    )
    .all(AGENT_RUN_JOB_ID_PREFIX + "%") as {
    id: string;
    expression: string;
    task_description: string;
    agent_id: string;
    tool_name: string;
    tool_args: string;
  }[];

  for (const row of rows) {
    if (!_taskMap.has(row.id)) {
      scheduleJob(_ctx, _runAgentFn, row, false);
    }
  }

  for (const [jobId, task] of _taskMap.entries()) {
    if (
      jobId.startsWith(AGENT_RUN_JOB_ID_PREFIX) &&
      !rows.some((r) => r.id === jobId)
    ) {
      task.stop();
      _taskMap.delete(jobId);
    }
  }
}

export function startCronScheduler(
  ctx: AppContext,
  runAgentFn: RunAgentFn,
  options: CronSchedulerOptions = {},
): void {
  if (_started) return;
  _started = true;
  _ctx = ctx;
  _runAgentFn = runAgentFn;

  syncAgentRunJobs(ctx);

  const runOnInit = options.runOnInit ?? false;
  const rows = ctx.db
    .prepare(
      "SELECT id, expression, task_description, agent_id, tool_name, tool_args FROM cron_jobs ORDER BY created_at",
    )
    .all() as {
    id: string;
    expression: string;
    task_description: string;
    agent_id: string;
    tool_name: string;
    tool_args: string;
  }[];

  for (const row of rows) {
    scheduleJob(ctx, runAgentFn, row, runOnInit);
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
  for (const task of _taskMap.values()) {
    task.stop();
  }
  _taskMap.clear();
  _started = false;
  _ctx = null;
  _runAgentFn = null;
}

/**
 * Updates the built-in heartbeat cron job from settings and re-schedules it with node-cron.
 * Call after changing heartbeatIntervalMinutes in settings so the in-process schedule reflects the new interval.
 * No-op if the cron scheduler has not been started.
 * @param ctx - Application context (used to read settings and update cron_jobs row)
 */
export function refreshHeartbeatJob(ctx: AppContext): void {
  if (!_started || !_ctx || !_runAgentFn) return;

  const minutes = getSettings(ctx).heartbeatIntervalMinutes;
  const expression = minutesToCronExpression(minutes);
  ctx.db
    .prepare("UPDATE cron_jobs SET expression = ? WHERE id = ?")
    .run(expression, BUILTIN_HEARTBEAT_JOB_ID);

  const existing = _taskMap.get(BUILTIN_HEARTBEAT_JOB_ID);
  if (existing) {
    existing.stop();
    _taskMap.delete(BUILTIN_HEARTBEAT_JOB_ID);
  }

  const row = ctx.db
    .prepare(
      "SELECT id, expression, task_description, agent_id, tool_name, tool_args FROM cron_jobs WHERE id = ?",
    )
    .get(BUILTIN_HEARTBEAT_JOB_ID) as
    | {
        id: string;
        expression: string;
        task_description: string;
        agent_id: string;
        tool_name: string;
        tool_args: string;
      }
    | undefined;
  if (row && cron.validate(row.expression)) {
    scheduleJob(_ctx, _runAgentFn, row, false);
  }
}

/**
 * Re-loads a single cron job from the DB and re-registers it with the scheduler.
 * Call after updating a job in the DB (e.g. via PATCH) so the in-process schedule reflects the change.
 * No-op if the scheduler is not started or the job is not found.
 * @param jobId - Cron job id (must exist in cron_jobs)
 */
export function refreshCronJob(jobId: string): void {
  if (!_started || !_ctx || !_runAgentFn) return;

  const row = _ctx.db
    .prepare(
      "SELECT id, expression, task_description, agent_id, tool_name, tool_args FROM cron_jobs WHERE id = ?",
    )
    .get(jobId) as
    | {
        id: string;
        expression: string;
        task_description: string;
        agent_id: string;
        tool_name: string;
        tool_args: string;
      }
    | undefined;
  if (!row) return;

  const existing = _taskMap.get(jobId);
  if (existing) {
    existing.stop();
    _taskMap.delete(jobId);
  }
  if (cron.validate(row.expression)) {
    scheduleJob(_ctx, _runAgentFn, row, false);
  }
}
