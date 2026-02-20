/**
 * @fileoverview Scheduler for agent_timers: restores timers from DB and runs heartbeat when they fire.
 * @module heartbeat/scheduler
 */

import type { DbClient } from "@/db/client";
import { createTimerRepository } from "@/db/timers";
import { debug } from "@/lib/logger";

export type SchedulerDeps = {
  /** Used only for initial listAll() when starting the scheduler. */
  db: DbClient;
  nowMs: () => number;
  /**
   * Called when a timer fires. Responsible for running heartbeat for the agent and,
   * when repeatMs > 0, persisting nextFire (e.g. open DB, run heartbeat, update timer, close DB).
   */
  onTimerFire: (
    agentId: string,
    timerId: string,
    nextFire: number,
    repeatMs: number
  ) => Promise<void>;
};

let timeouts: ReturnType<typeof setTimeout>[] = [];

/**
 * Schedules a single timer. When it fires, calls onTimerFire and reschedules if repeat_ms > 0.
 */
function scheduleOne(
  deps: SchedulerDeps,
  id: string,
  agentId: string,
  fireAtMs: number,
  repeatMs: number
): void {
  const delay = Math.max(0, fireAtMs - deps.nowMs());
  debug("timer", { event: "scheduled", timerId: id, agentId, fireAtMs, repeatMs, delayMs: delay });
  const t = setTimeout(async () => {
    debug("timer", { event: "fired", timerId: id, agentId });
    const nextFire = repeatMs > 0 ? deps.nowMs() + repeatMs : 0;
    await deps.onTimerFire(agentId, id, nextFire, repeatMs);
    if (repeatMs > 0) {
      debug("timer", { event: "rescheduled", timerId: id, agentId, nextFireMs: nextFire, repeatMs });
      scheduleOne(deps, id, agentId, nextFire, repeatMs);
    }
  }, delay);
  timeouts.push(t);
}

/**
 * Loads all agent_timers from DB and schedules them. Call on app startup.
 */
export async function startScheduler(deps: SchedulerDeps): Promise<void> {
  const repo = createTimerRepository(deps.db);
  const all = await repo.listAll();
  debug("timer", { event: "scheduler_start", timerCount: all.length });
  for (const timer of all) {
    scheduleOne(
      deps,
      timer.id,
      timer.agent_id,
      timer.fire_at_ms,
      timer.repeat_ms
    );
  }
}

/**
 * Stops all scheduled timers (for tests or shutdown).
 */
export function stopScheduler(): void {
  for (const t of timeouts) {
    clearTimeout(t);
  }
  timeouts = [];
}
