/**
 * @fileoverview In-process cron job scheduler: loads jobs from cron_jobs table,
 * registers them with node-cron, and runs agent messages when they fire.
 * Agent cron jobs are created via the Schedules UI or Maia's `cron_schedule` tool (Maia-only).
 * @module lib/cron/service
 */
import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import type { AppContext } from "../context";
import { getOrCreateSession } from "../history";
import type { RunAgentFn, RunAgentOptions } from "../agent/runner";
import { fireHeartbeat } from "../heartbeat";
import { getSettings } from "../settings";
import { enqueue } from "../queue/llm-queue";
import {
  BUILTIN_HEARTBEAT_JOB_ID,
  minutesToCronExpression,
} from "./expression";
import { DEFAULT_CRON_WAKE_PROMPT } from "./default-wake-prompt";
import { getPersonaById } from "../personas/registry";
import { normalizeReasoningEffort } from "../agent/identity";

export interface CronSchedulerOptions {
  /**
   * When true, each scheduled job runs once immediately after registration (for testing).
   * @default false
   */
  runOnInit?: boolean;
}

/** Parsed cron row fields used to choose persona vs Maia prompt wake. */
interface CronWakeRowParts {
  persona_id: string | null | undefined;
  persona_model: string | null | undefined;
  cron_message: string | null | undefined;
}

/**
 * @brief Builds `runAgent` message and options for a scheduled cron row (excluding heartbeat).
 * @param ctx - Application context (settings whitelist)
 * @param agentId - Owning agent id from the cron row
 * @param jobId - Cron job id (logging)
 * @param parts - Persona/message payload from SQLite
 * @returns Envelope or null when the job should be skipped (misconfiguration)
 */
function buildCronWakeEnvelope(
  ctx: AppContext,
  agentId: string,
  jobId: string,
  parts: CronWakeRowParts,
): { message: string; options: RunAgentOptions } | null {
  const personaSlug =
    typeof parts.persona_id === "string" ? parts.persona_id.trim() : "";

  if (personaSlug) {
    if (agentId !== "maia") {
      console.warn(
        `CronService: job ${jobId} uses persona_id but agent_id is not maia; skipping`,
      );
      return null;
    }
    const persona = getPersonaById(personaSlug);
    if (!persona) {
      console.warn(
        `CronService: job ${jobId} references unknown persona "${personaSlug}"; skipping`,
      );
      return null;
    }
    const personaModelRaw =
      typeof parts.persona_model === "string"
        ? parts.persona_model.trim()
        : "";
    if (!personaModelRaw) {
      console.warn(
        `CronService: job ${jobId} missing persona_model for persona wake; skipping`,
      );
      return null;
    }
    const settings = getSettings(ctx);
    if (!settings.whitelistedModels.includes(personaModelRaw)) {
      console.warn(
        `CronService: job ${jobId} persona_model not whitelisted: ${personaModelRaw}`,
      );
      return null;
    }
    const rawMsg = parts.cron_message;
    const message =
      rawMsg != null && String(rawMsg).trim() !== ""
        ? String(rawMsg).trim()
        : DEFAULT_CRON_WAKE_PROMPT;
    const reasoningEffort = normalizeReasoningEffort(
      persona.suggestedReasoningEffort ?? "medium",
    );
    return {
      message,
      options: {
        personaTurn: {
          id: persona.id,
          name: persona.name,
          instructions: persona.instructions,
          model: personaModelRaw,
          reasoningEffort,
        },
      },
    };
  }

  const raw = parts.cron_message;
  const trimmed =
    raw != null && String(raw).trim() !== "" ? String(raw).trim() : "";
  const message = trimmed !== "" ? trimmed : DEFAULT_CRON_WAKE_PROMPT;
  return { message, options: {} };
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
 * Schedules a single job and adds it to _taskMap. Used by startCronScheduler and refreshHeartbeatJob.
 * Non-heartbeat jobs enqueue **runAgent** with Maia prompt wake or delegated persona wake.
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
    persona_id: string | null;
    persona_model: string | null;
    cron_message: string | null;
  },
  runOnInit: boolean,
): void {
  const {
    id: jobId,
    expression,
    task_description: taskDescription,
    agent_id: agentId,
    persona_id,
    persona_model,
    cron_message,
  } = row;

  const isHeartbeat = jobId === BUILTIN_HEARTBEAT_JOB_ID;

  const agentExists = ctx.db
    .prepare("SELECT 1 FROM agents WHERE id = ? AND status != 'deleted'")
    .get(agentId);
  if (!agentExists) {
    console.warn(
      `CronService: skipping job ${jobId} — target agent ${agentId} not found or deleted`,
    );
    return;
  }

  if (!isHeartbeat && agentId !== "maia") {
    console.warn(
      `CronService: skipping job ${jobId} — schedules must use agent id "maia"`,
    );
    return;
  }

  if (!cron.validate(expression)) {
    console.error(
      `CronService: invalid expression for job ${jobId}, skipping: ${expression}`,
    );
    return;
  }
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
          const wake = buildCronWakeEnvelope(ctx, agentId, jobId, {
            persona_id,
            persona_model,
            cron_message,
          });
          if (!wake) return;
          enqueue(
            {
              tool: "runAgent",
              args: {
                agentId,
                sessionId,
                message: wake.message,
                options: wake.options,
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

export function startCronScheduler(
  ctx: AppContext,
  runAgentFn: RunAgentFn,
  options: CronSchedulerOptions = {},
): void {
  if (_started) return;
  _started = true;
  _ctx = ctx;
  _runAgentFn = runAgentFn;

  const runOnInit = options.runOnInit ?? false;
  const rows = ctx.db
    .prepare(
      "SELECT id, expression, task_description, agent_id, tool_name, tool_args, persona_id, persona_model, cron_message FROM cron_jobs ORDER BY created_at",
    )
    .all() as {
    id: string;
    expression: string;
    task_description: string;
    agent_id: string;
    tool_name: string;
    tool_args: string;
    persona_id: string | null;
    persona_model: string | null;
    cron_message: string | null;
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
      "SELECT id, expression, task_description, agent_id, tool_name, tool_args, persona_id, persona_model, cron_message FROM cron_jobs WHERE id = ?",
    )
    .get(BUILTIN_HEARTBEAT_JOB_ID) as
    | {
        id: string;
        expression: string;
        task_description: string;
        agent_id: string;
        tool_name: string;
        tool_args: string;
        persona_id: string | null;
        persona_model: string | null;
        cron_message: string | null;
      }
    | undefined;
  if (row && cron.validate(row.expression)) {
    scheduleJob(_ctx, _runAgentFn, row, false);
  }
}

/**
 * Stops and removes a cron job from the in-process scheduler (e.g. after the job was deleted from the DB).
 * No-op if the scheduler is not started or the job is not currently scheduled.
 * @param jobId - Cron job id to unschedule
 */
export function unscheduleCronJob(jobId: string): void {
  if (!_started) return;

  const existing = _taskMap.get(jobId);
  if (existing) {
    existing.stop();
    _taskMap.delete(jobId);
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
      "SELECT id, expression, task_description, agent_id, tool_name, tool_args, persona_id, persona_model, cron_message FROM cron_jobs WHERE id = ?",
    )
    .get(jobId) as
    | {
        id: string;
        expression: string;
        task_description: string;
        agent_id: string;
        tool_name: string;
        tool_args: string;
        persona_id: string | null;
        persona_model: string | null;
        cron_message: string | null;
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
