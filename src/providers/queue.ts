/**
 * @fileoverview Bounded FIFO request queue for limiting concurrent operations.
 * @module providers/queue
 *
 * @brief Manages a queue of async functions, enforcing max concurrency and
 * max queue depth. Rejects new items when the queue is full.
 */

import type { Clock } from "../core/types.js";

/**
 * @brief Dependencies for creating the request queue.
 */
export interface RequestQueueDeps {
  /** Maximum number of functions running simultaneously. */
  maxConcurrent: number;
  /** Maximum number of items waiting in the queue. */
  maxQueueDepth: number;
  /** Clock abstraction (for future time-based features). */
  clock: Clock;
}

/**
 * @brief Request queue interface.
 */
export interface RequestQueue {
  /** Enqueue a function. Returns its result when it runs. Rejects if queue full. */
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  /** Current number of items waiting (not yet running). */
  depth(): number;
}

interface QueuedItem<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

/**
 * @brief Creates a bounded FIFO request queue.
 * @param deps - Dependencies: maxConcurrent, maxQueueDepth, clock
 * @returns RequestQueue instance
 */
export function createRequestQueue(deps: RequestQueueDeps): RequestQueue {
  const { maxConcurrent, maxQueueDepth } = deps;
  const queue: QueuedItem<unknown>[] = [];
  let running = 0;

  function process(): void {
    while (running < maxConcurrent && queue.length > 0) {
      const item = queue.shift()!;
      running++;
      Promise.resolve()
        .then(() => item.fn())
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          running--;
          process();
        });
    }
  }

  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      if (queue.length >= maxQueueDepth) {
        return Promise.reject(new Error("Queue full"));
      }

      return new Promise<T>((resolve, reject) => {
        queue.push({ fn, resolve, reject } as QueuedItem<unknown>);
        process();
      });
    },

    depth(): number {
      return queue.length;
    },
  };
}
