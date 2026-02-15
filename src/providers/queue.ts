/**
 * @fileoverview Sync priority request queue for LLM operations. Holds serializable
 * action+args+submitterAgentId; no async execution inside the queue. Manager runs
 * workers that claimNext(), run handlers, then remove (success) or release (retry).
 * @module providers/queue
 *
 * @brief Three queues (user, agent, background); one worker per queue. Job stays
 * in queue until success; on failure release(jobId) moves it back to pending.
 */

import type { Clock } from "../core/types.js";

/**
 * @brief Priority levels for queue items.
 * @note "user" is highest priority, "background" is lowest. One dedicated worker per queue.
 */
export type QueuePriority = "user" | "agent" | "background";

/**
 * @brief Serializable queue item: action + args + submitterAgentId (no function refs).
 */
export interface QueuedItem {
  id: string;
  action: string;
  args: Record<string, unknown>;
  priority: QueuePriority;
  createdAt: string;
  submitterAgentId: string;
}

/**
 * @brief Job status as seen by the queue (completed is tracked by manager/result registry).
 */
export type JobStatus = "queued" | "running" | "not_found";

/**
 * @brief Dependencies for creating the request queue.
 */
export interface RequestQueueDeps {
  /** Maximum number of items per priority queue (pending + running). */
  maxQueueDepth: number;
  /** Clock for createdAt on items. */
  clock: Clock;
}

/**
 * @brief Request queue interface: sync enqueue, claimNext per priority, remove/release, getJobStatus.
 */
export interface RequestQueue {
  /**
   * @brief Enqueue a serializable action. Returns jobId synchronously.
   * @param action - Action name (e.g. "handleUserChat")
   * @param args - Serializable args for the action
   * @param priority - Which queue (user / agent / background)
   * @param submitterAgentId - Agent (or "user"/"maia") to receive the result when job completes
   * @returns Job ID (sync)
   * @throws Error if that priority queue is full
   */
  enqueue(
    action: string,
    args: Record<string, unknown>,
    priority: QueuePriority,
    submitterAgentId: string
  ): string;

  /**
   * @brief Claim the next item from the given priority queue (moves pending -> running).
   * @param priority - Which queue to claim from
   * @returns The item, or undefined if that queue has no pending items
   */
  claimNext(priority: QueuePriority): QueuedItem | undefined;

  /**
   * @brief Remove the job from the queue (call on success). Job must be in running state.
   * @param jobId - Job ID returned from enqueue
   */
  remove(jobId: string): void;

  /**
   * @brief Move the job from running back to pending (call on retriable failure).
   * @param jobId - Job ID
   */
  release(jobId: string): void;

  /**
   * @brief Total number of items (pending + running) across all three queues.
   */
  depth(): number;

  /**
   * @brief Status of a job: queued (pending), running (claimed), or not_found.
   * @note "completed" is not returned by the queue; manager/result layer tracks that.
   */
  getJobStatus(jobId: string): JobStatus;

  /**
   * @brief All items (pending + running) for persistence. Manager writes these to file.
   */
  getItemsForPersistence(): QueuedItem[];

  /**
   * @brief Re-enqueue items after load (e.g. on startup). All items go back to pending.
   * @param items - Items previously returned from getItemsForPersistence
   */
  restore(items: QueuedItem[]): void;
}

interface SingleQueueState {
  pending: QueuedItem[];
  running: Map<string, QueuedItem>;
}

/**
 * @brief Creates a sync request queue with three priority queues (user, agent, background).
 * @param deps - maxQueueDepth, clock
 * @returns RequestQueue instance
 *
 * @example
 * const queue = createRequestQueue({ maxQueueDepth: 50, clock });
 * const jobId = queue.enqueue("handleUserChat", { message }, "user", "user");
 * const item = queue.claimNext("user");
 * if (item) { const result = await runHandler(item); queue.remove(item.id); }
 */
export function createRequestQueue(deps: RequestQueueDeps): RequestQueue {
  const { maxQueueDepth, clock } = deps;
  const priorities: QueuePriority[] = ["user", "agent", "background"];
  const queues = new Map<QueuePriority, SingleQueueState>();
  for (const p of priorities) {
    const state: SingleQueueState = { pending: [], running: new Map<string, QueuedItem>() };
    queues.set(p, state);
  }
  const jobIdToPriority = new Map<string, QueuePriority>();

  function totalDepth(): number {
    let n = 0;
    for (const state of queues.values()) {
      n += state.pending.length + state.running.size;
    }
    return n;
  }

  function queueDepth(priority: QueuePriority): number {
    const state = queues.get(priority)!;
    return state.pending.length + state.running.size;
  }

  function findNextPendingIndex(priority: QueuePriority): number {
    const state = queues.get(priority)!;
    if (state.pending.length === 0) return -1;
    return 0;
  }

  return {
    enqueue(
      action: string,
      args: Record<string, unknown>,
      priority: QueuePriority,
      submitterAgentId: string
    ): string {
      const state = queues.get(priority)!;
      if (queueDepth(priority) >= maxQueueDepth) {
        throw new Error("Queue full");
      }
      const id = `job_${clock.now().getTime()}_${Math.random().toString(36).slice(2, 10)}`;
      const item: QueuedItem = {
        id,
        action,
        args,
        priority,
        createdAt: clock.timestamp(),
        submitterAgentId,
      };
      state.pending.push(item);
      jobIdToPriority.set(id, priority);
      return id;
    },

    claimNext(priority: QueuePriority): QueuedItem | undefined {
      const state = queues.get(priority)!;
      const idx = findNextPendingIndex(priority);
      if (idx === -1) return undefined;
      const item = state.pending.splice(idx, 1)[0];
      state.running.set(item.id, item);
      return item;
    },

    remove(jobId: string): void {
      const priority = jobIdToPriority.get(jobId);
      if (!priority) return;
      const state = queues.get(priority)!;
      if (state.running.has(jobId)) {
        state.running.delete(jobId);
        jobIdToPriority.delete(jobId);
      }
    },

    release(jobId: string): void {
      const priority = jobIdToPriority.get(jobId);
      if (!priority) return;
      const state = queues.get(priority)!;
      const item = state.running.get(jobId);
      if (item) {
        state.running.delete(jobId);
        state.pending.push(item);
      }
    },

    depth(): number {
      return totalDepth();
    },

    getJobStatus(jobId: string): JobStatus {
      const priority = jobIdToPriority.get(jobId);
      if (!priority) return "not_found";
      const state = queues.get(priority)!;
      if (state.running.has(jobId)) return "running";
      if (state.pending.some((i) => i.id === jobId)) return "queued";
      return "not_found";
    },

    getItemsForPersistence(): QueuedItem[] {
      const out: QueuedItem[] = [];
      for (const state of queues.values()) {
        for (const item of state.pending) out.push(item);
        for (const item of state.running.values()) out.push(item);
      }
      return out;
    },

    restore(items: QueuedItem[]): void {
      for (const state of queues.values()) {
        state.pending.length = 0;
        state.running.clear();
      }
      jobIdToPriority.clear();
      for (const item of items) {
        const state = queues.get(item.priority)!;
        if (state.pending.length + state.running.size < maxQueueDepth) {
          state.pending.push(item);
          jobIdToPriority.set(item.id, item.priority);
        }
      }
    },
  };
}
