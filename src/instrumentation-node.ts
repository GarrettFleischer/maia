/**
 * @fileoverview Node-only startup: ensure Maia agent exists, start timer scheduler and interval heartbeat.
 * @module instrumentation-node
 *
 * Loaded from instrumentation.ts only when NEXT_RUNTIME === "nodejs".
 * Creates the Maia agent if she does not exist, then starts the heartbeat scheduler so timer-driven
 * heartbeats run when agent_timers fire, and the interval-based heartbeat when MAIA_HEARTBEAT_INTERVAL_MS > 0.
 * Each tick and each timer fire opens a fresh DB connection so newly added agents are seen.
 */

import { createAgentRepository, MAIA_AGENT_ID } from "@/db/agents";
import { createTimerRepository } from "@/db/timers";
import { openDb } from "@/db/client";
import { createContainer } from "@/lib/container";
import { createHeartbeatDeps } from "@/heartbeat/deps";
import { startHeartbeatIntervalWithFactory } from "@/heartbeat/interval";
import { runHeartbeatForAgent } from "@/heartbeat/runner";
import { startScheduler } from "@/heartbeat/scheduler";
import fs from "node:fs";

const fsDeps = {
  mkdir: (p: string) => fs.mkdirSync(p, { recursive: true }),
  writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
};

/**
 * Opens the DB (for loading timers only), starts the scheduler and (when configured) the heartbeat interval.
 * Each tick and each timer fire opens a fresh DB so the heartbeat sees the latest agents.
 */
/** Maia agent purpose: curious about self and user, ask for input until satisfied about role and how to help. */
const MAIA_PURPOSE =
  "Be curious about yourself and the user. Ask the user for input about what they need and how you can help. Keep learning until you're satisfied about your role and how you can help.";

export async function startHeartbeatScheduler(): Promise<void> {
  const container = createContainer();
  const db = await openDb(container.dbPath);

  const agentRepo = createAgentRepository(db, container.sandboxRoot, fsDeps);
  if (!(await agentRepo.get(MAIA_AGENT_ID))) {
    await agentRepo.create({
      id: MAIA_AGENT_ID,
      name: "Maia",
      purpose: MAIA_PURPOSE,
      model: null,
    });
  }

  await startScheduler({
    db,
    nowMs: () => Date.now(),
    onTimerFire: async (
      agentId: string,
      timerId: string,
      nextFire: number,
      repeatMs: number
    ) => {
      const timerDb = await openDb(container.dbPath);
      try {
        const heartbeatDeps = createHeartbeatDeps({
          db: timerDb,
          sandboxRoot: container.sandboxRoot,
          fs: fsDeps,
        });
        await runHeartbeatForAgent(heartbeatDeps, agentId);
        if (repeatMs > 0) {
          const timerRepo = createTimerRepository(timerDb);
          await timerRepo.updateNextFire(timerId, nextFire);
        }
      } finally {
        timerDb.close();
      }
    },
  });
  db.close();

  const raw = process.env.MAIA_HEARTBEAT_INTERVAL_MS;
  const intervalMs = raw ? parseInt(raw, 10) : 60_000;
  if (intervalMs > 0) {
    startHeartbeatIntervalWithFactory(async () => {
      const tickDb = await openDb(container.dbPath);
      const deps = createHeartbeatDeps({
        db: tickDb,
        sandboxRoot: container.sandboxRoot,
        fs: fsDeps,
      });
      return {
        deps,
        close: () => tickDb.close(),
      };
    }, intervalMs);
  }
}
