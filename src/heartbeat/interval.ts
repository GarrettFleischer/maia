/**
 * @fileoverview Interval-based heartbeat: runs runHeartbeatOnce every N ms and returns a stop handle.
 * @module heartbeat/interval
 *
 * Used by Node instrumentation to run heartbeats for all enabled agents on MAIA_HEARTBEAT_INTERVAL_MS.
 */

import type { RunHeartbeatOnceDeps } from "@/heartbeat/runner";
import { runHeartbeatOnce } from "@/heartbeat/runner";

export type HeartbeatIntervalHandle = {
  /** Stops the interval; no further ticks will run. */
  stop: () => void;
};

export type HeartbeatDepsWithClose = {
  deps: RunHeartbeatOnceDeps;
  /** Called after the tick so the caller can close DB or release resources. */
  close?: () => void;
};

/**
 * Starts a recurring interval that runs one heartbeat tick (all enabled agents) every intervalMs.
 *
 * @param deps - Deps for runHeartbeatOnce (sandbox, listEnabledAgents, runAgentTurn).
 * @param intervalMs - Period in milliseconds between ticks.
 * @returns Handle with stop() to clear the interval.
 * @note Rejected runHeartbeatOnce promises are caught so the interval keeps running; consider logging in production.
 *
 * @example
 * const { stop } = startHeartbeatInterval(heartbeatDeps, 60_000);
 * // later: stop();
 */
export function startHeartbeatInterval(
  deps: RunHeartbeatOnceDeps,
  intervalMs: number
): HeartbeatIntervalHandle {
  const id = setInterval(() => {
    runHeartbeatOnce(deps).catch(() => {
      // Log and continue; do not throw so the interval keeps running
    });
  }, intervalMs);

  return {
    stop: () => clearInterval(id),
  };
}

/**
 * Starts a recurring interval that fetches fresh deps each tick (e.g. open DB, create deps, run tick, close DB).
 * Use this so each tick sees the latest agents and other DB state instead of a stale in-memory snapshot.
 * Ticks are serialized: the next tick does not start until the previous tick (and its close()) have finished,
 * so the next tick reads the DB after the previous one has persisted.
 *
 * @param getDeps - Called at the start of each tick; return deps and optional close() to run after the tick.
 * @param intervalMs - Delay in milliseconds after each tick completes before starting the next.
 * @returns Handle with stop() to clear the interval.
 */
export function startHeartbeatIntervalWithFactory(
  getDeps: () => Promise<HeartbeatDepsWithClose>,
  intervalMs: number
): HeartbeatIntervalHandle {
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  function runTick(): void {
    if (stopped) return;
    getDeps()
      .then(({ deps, close }) =>
        runHeartbeatOnce(deps).then(
          () => {
            close?.();
          },
          (err) => {
            close?.();
            throw err;
          }
        )
      )
      .catch(() => {
        // Log and continue; do not throw so the interval keeps running
      })
      .finally(() => {
        if (!stopped) {
          timeoutId = setTimeout(runTick, intervalMs);
        }
      });
  }

  runTick();

  return {
    stop: () => {
      stopped = true;
      if (timeoutId != null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
}
