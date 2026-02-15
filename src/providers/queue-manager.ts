/**
 * @fileoverview Queue manager: runs workers that claim items, execute action handlers,
 * and deliver results via job result registry. Persists pending+running; loads on startup.
 * @module providers/queue-manager
 *
 * @brief One worker per priority queue; on success remove and completeJob; on network
 * error release for retry. isNetworkError centralizes retriable error detection.
 */

import type { Clock, FileSystem, Logger } from "../core/types.js";
import {
  createRequestQueue,
  type QueuePriority,
  type QueuedItem,
  type RequestQueue,
} from "./queue.js";

/**
 * @brief Job status including "completed" (manager tracks completed jobs).
 */
export type ManagerJobStatus = "queued" | "running" | "completed" | "not_found";

/**
 * @brief Queue status summary for brain context (pending counts, running job ids/actions).
 */
export interface QueueStatusSummary {
  user: { pending: number; running: Array<{ jobId: string; action: string }> };
  agent: { pending: number; running: Array<{ jobId: string; action: string }> };
  background: { pending: number; running: Array<{ jobId: string; action: string }> };
}

export interface QueueManagerDeps {
  maxQueueDepth: number;
  clock: Clock;
  logger: Logger;
  persistPath?: string;
  fs?: FileSystem;
}

export type ActionHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * @brief Job result registry: wait for result, complete/fail job.
 */
interface JobResultRegistry {
  waitForJobResult(jobId: string): Promise<unknown>;
  completeJob(jobId: string, result: unknown): void;
  failJob(jobId: string, err: unknown): void;
  isCompleted(jobId: string): boolean;
}

function createJobResultRegistry(): JobResultRegistry {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: unknown) => void }
  >();
  const completed = new Set<string>();

  return {
    waitForJobResult(jobId: string): Promise<unknown> {
      if (completed.has(jobId)) {
        return Promise.resolve(undefined);
      }
      return new Promise((resolve, reject) => {
        pending.set(jobId, { resolve, reject });
      });
    },
    completeJob(jobId: string, result: unknown): void {
      completed.add(jobId);
      const p = pending.get(jobId);
      if (p) {
        pending.delete(jobId);
        p.resolve(result);
      }
    },
    failJob(jobId: string, err: unknown): void {
      const p = pending.get(jobId);
      if (p) {
        pending.delete(jobId);
        p.reject(err);
      }
    },
    isCompleted(jobId: string): boolean {
      return completed.has(jobId);
    },
  };
}

/**
 * @brief Treat as retriable: 429, rate limit, ECONNRESET, ETIMEDOUT, network-related message or code.
 * @param err - The error to check
 * @returns True if the error is a network/rate-limit error that should trigger release and retry
 */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const code = (err as NodeJS.ErrnoException).code;
    if (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("too many requests") ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("network")
    ) {
      return true;
    }
  }
  if (typeof err === "object" && err !== null && "status" in err) {
    if ((err as { status: unknown }).status === 429) return true;
  }
  return false;
}

export interface QueueManager {
  /** Sync enqueue; returns jobId. */
  enqueue(
    action: string,
    args: Record<string, unknown>,
    priority: QueuePriority,
    submitterAgentId: string
  ): string;
  /** Wait for job result (resolved when worker completes the job). */
  waitForJobResult(jobId: string): Promise<unknown>;
  /** Job status: queued | running | completed | not_found. */
  getJobStatus(jobId: string): ManagerJobStatus;
  /** Summary for brain context (pending counts, running job ids/actions). */
  getQueueStatusSummary(): QueueStatusSummary;
  /** Register action handler. Call before startWorkers. */
  registerHandler(action: string, handler: ActionHandler): void;
  /** Start one worker per queue. Call after registering handlers. */
  startWorkers(): void;
  /** Load persisted items and restore to queue. Call after start. */
  loadFromFile(): Promise<void>;
  /** Underlying queue (e.g. for persistence or tests). */
  getQueue(): RequestQueue;
}

/**
 * @brief Creates the queue manager: queue + job result registry + workers + persistence.
 * @param deps - maxQueueDepth, clock, logger, optional persistPath, fs
 * @returns QueueManager instance
 */
export function createQueueManager(deps: QueueManagerDeps): QueueManager {
  const { maxQueueDepth, clock, logger, persistPath, fs } = deps;
  const queue = createRequestQueue({ maxQueueDepth, clock });
  const jobResultRegistry = createJobResultRegistry();
  const actionHandlers = new Map<string, ActionHandler>();
  let workerAbort = false;

  async function persist(): Promise<void> {
    if (!persistPath || !fs) return;
    try {
      const items = queue.getItemsForPersistence();
      await fs.writeFile(persistPath, JSON.stringify(items, null, 0));
    } catch (e) {
      logger.warn("Queue persist failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function runWorker(priority: QueuePriority): Promise<void> {
    while (!workerAbort) {
      const item = queue.claimNext(priority);
      if (!item) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const handler = actionHandlers.get(item.action);
      if (!handler) {
        queue.remove(item.id);
        jobResultRegistry.failJob(
          item.id,
          new Error(`No handler for action: ${item.action}`)
        );
        continue;
      }
      try {
        const result = await handler(item.args);
        queue.remove(item.id);
        jobResultRegistry.completeJob(item.id, result);
        await persist();
      } catch (e) {
        if (isNetworkError(e)) {
          queue.release(item.id);
          logger.debug("Job released for retry (network error)", {
            jobId: item.id,
            action: item.action,
            error: e instanceof Error ? e.message : String(e),
          });
        } else {
          queue.remove(item.id);
          jobResultRegistry.failJob(item.id, e);
          await persist();
          logger.warn("Job failed", {
            jobId: item.id,
            action: item.action,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }

  return {
    enqueue(
      action: string,
      args: Record<string, unknown>,
      priority: QueuePriority,
      submitterAgentId: string
    ): string {
      return queue.enqueue(action, args, priority, submitterAgentId);
    },

    waitForJobResult(jobId: string): Promise<unknown> {
      return jobResultRegistry.waitForJobResult(jobId);
    },

    getJobStatus(jobId: string): ManagerJobStatus {
      if (jobResultRegistry.isCompleted(jobId)) return "completed";
      return queue.getJobStatus(jobId) as ManagerJobStatus;
    },

    getQueueStatusSummary(): QueueStatusSummary {
      const items = queue.getItemsForPersistence();
      const summary: QueueStatusSummary = {
        user: { pending: 0, running: [] },
        agent: { pending: 0, running: [] },
        background: { pending: 0, running: [] },
      };
      for (const item of items) {
        const s = summary[item.priority];
        const status = queue.getJobStatus(item.id);
        if (status === "running") {
          s.running.push({ jobId: item.id, action: item.action });
        } else {
          s.pending++;
        }
      }
      return summary;
    },

    registerHandler(action: string, handler: ActionHandler): void {
      actionHandlers.set(action, handler);
    },

    startWorkers(): void {
      workerAbort = false;
      const priorities: QueuePriority[] = ["user", "agent", "background"];
      for (const p of priorities) {
        void runWorker(p);
      }
    },

    async loadFromFile(): Promise<void> {
      if (!persistPath || !fs) return;
      try {
        const exists = await fs.exists(persistPath);
        if (!exists) return;
        const raw = await fs.readFile(persistPath);
        const parsed = JSON.parse(raw) as QueuedItem[];
        if (!Array.isArray(parsed)) return;
        const valid = parsed.filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.action === "string" &&
            item.args &&
            item.priority &&
            item.submitterAgentId
        );
        queue.restore(valid);
        logger.info("Queue loaded from file", { count: valid.length });
      } catch (e) {
        logger.warn("Queue load failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },

    getQueue(): RequestQueue {
      return queue;
    },
  };
}
