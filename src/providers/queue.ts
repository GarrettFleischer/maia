/**
 * @fileoverview Priority request queue for LLM operations with rate-limit retry.
 * @module providers/queue
 *
 * @brief Manages a priority queue of async functions and serializable jobs. User
 * requests always dequeue first, then agent, then background. Supports persisting
 * job descriptors to JSON so shutdown does not lose pending work. Automatically
 * retries on rate-limit errors with exponential backoff.
 */

import type { Clock, FileSystem } from "../core/types.js";

/**
 * @brief Priority levels for queue items.
 * @note "user" is highest priority (dequeued first), "background" is lowest.
 */
export type QueuePriority = "user" | "agent" | "background";

/**
 * @brief Serializable job descriptor for persisted queue items.
 */
export interface JobDescriptor {
  id: string;
  type: string;
  priority: QueuePriority;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * @brief Job handler signature. Registered per job type at app startup.
 */
export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/**
 * @brief Dependencies for creating the request queue.
 */
export interface RequestQueueDeps {
  /** Maximum number of functions running simultaneously. */
  maxConcurrent: number;
  /** Maximum number of items waiting in the queue. */
  maxQueueDepth: number;
  /** Clock abstraction (for time-based features). */
  clock: Clock;
  /** Maximum retry attempts on rate-limit errors (default: 3). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff on rate-limit (default: 1000). */
  retryBaseDelayMs?: number;
  /** Maximum backoff delay in ms (default: 30000). */
  retryMaxDelayMs?: number;
  /** Optional: path to JSON file for persisting pending jobs. */
  persistPath?: string;
  /** Optional: filesystem for reading/writing persist file. Required if persistPath is set. */
  fs?: FileSystem;
  /** Optional: map of job type -> handler. Required to run enqueued jobs. */
  jobHandlers?: Record<string, JobHandler>;
}

/**
 * @brief Request queue interface.
 */
export interface RequestQueue {
  /**
   * @brief Enqueue a function at the given priority. Returns its result when it runs.
   * @param fn - Async function to execute
   * @param priority - Priority level (default: "agent")
   * @returns Promise resolving to the function's result
   * @throws Error if queue is full
   */
  enqueue<T>(fn: () => Promise<T>, priority?: QueuePriority): Promise<T>;

  /**
   * @brief Enqueue a serializable job. Resolves when the job is queued (not when it completes).
   * Jobs are persisted to persistPath if configured. Handlers are invoked by job type.
   * @param descriptor - Job type and payload (id and createdAt are added automatically)
   * @param priority - Priority level (default: "background")
   */
  enqueueJob(
    descriptor: { type: string; payload: Record<string, unknown> },
    priority?: QueuePriority
  ): Promise<void>;

  /**
   * @brief Load pending jobs from the persist file and re-enqueue them. Call after startup.
   * No-op if persistPath/fs not configured.
   */
  loadFromFile(): Promise<void>;

  /** Current number of items waiting (not yet running). */
  depth(): number;

  /** Current number of items running. */
  running(): number;

  /** Whether the queue is currently paused due to rate limiting. */
  isPaused(): boolean;
}

/**
 * @brief Internal queued item: either a function or a job descriptor.
 */
type QueuedItem =
  | {
      kind: "fn";
      fn: () => Promise<unknown>;
      priority: QueuePriority;
      resolve: (value: unknown) => void;
      reject: (err: unknown) => void;
      retryCount: number;
    }
  | {
      kind: "job";
      id: string;
      type: string;
      priority: QueuePriority;
      payload: Record<string, unknown>;
      createdAt: string;
    };

/**
 * @brief Priority ordering: lower number = higher priority (dequeued first).
 */
const PRIORITY_ORDER: Record<QueuePriority, number> = {
  user: 0,
  agent: 1,
  background: 2,
};

/**
 * @brief Checks if an error is a rate-limit error (HTTP 429 or similar).
 * @param err - The error to check
 * @returns True if this looks like a rate-limit error
 */
function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
      return true;
    }
  }
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (status === 429) return true;
  }
  return false;
}

/**
 * @brief Creates a priority request queue with rate-limit retry and optional job persistence.
 * @param deps - Dependencies: maxConcurrent, maxQueueDepth, clock, optional persistPath, fs, jobHandlers
 * @returns RequestQueue instance
 *
 * @example
 * const queue = createRequestQueue({ maxConcurrent: 2, maxQueueDepth: 50, clock });
 * await queue.enqueue(() => provider.chat(messages), "user");
 * await queue.enqueueJob({ type: "tool_review", payload: { proposalId: "..." } }, "background");
 * await queue.loadFromFile(); // after startup
 */
export function createRequestQueue(deps: RequestQueueDeps): RequestQueue {
  const {
    maxConcurrent,
    maxQueueDepth,
    clock,
    maxRetries = 3,
    retryBaseDelayMs = 1000,
    retryMaxDelayMs = 30000,
    persistPath,
    fs,
    jobHandlers = {},
  } = deps;

  const queue: QueuedItem[] = [];
  let runningCount = 0;
  let paused = false;

  function findNextIndex(): number {
    if (queue.length === 0) return -1;
    let bestIdx = 0;
    let bestPriority = PRIORITY_ORDER[queue[0].priority];
    for (let i = 1; i < queue.length; i++) {
      const p = PRIORITY_ORDER[queue[i].priority];
      if (p < bestPriority) {
        bestPriority = p;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function backoffDelay(attempt: number): number {
    const delay = retryBaseDelayMs * Math.pow(2, attempt);
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    return Math.min(delay + jitter, retryMaxDelayMs);
  }

  function pauseQueue(delayMs: number): void {
    if (paused) return;
    paused = true;
    setTimeout(() => {
      paused = false;
      process();
    }, delayMs);
  }

  async function persist(): Promise<void> {
    if (!persistPath || !fs) return;
    const jobItems = queue.filter((item): item is QueuedItem & { kind: "job" } => item.kind === "job");
    const toWrite = jobItems.map((item) => ({
      id: item.id,
      type: item.type,
      priority: item.priority,
      payload: item.payload,
      createdAt: item.createdAt,
    }));
    try {
      await fs.writeFile(persistPath, JSON.stringify(toWrite, null, 0));
    } catch {
      // Best-effort; do not throw
    }
  }

  function process(): void {
    if (paused) return;

    while (runningCount < maxConcurrent && queue.length > 0) {
      const idx = findNextIndex();
      if (idx === -1) break;
      const item = queue.splice(idx, 1)[0];
      runningCount++;

      if (item.kind === "fn") {
        Promise.resolve()
          .then(() => item.fn())
          .then((result) => {
            item.resolve(result);
          })
          .catch((err) => {
            if (isRateLimitError(err) && item.retryCount < maxRetries) {
              item.retryCount++;
              const delay = backoffDelay(item.retryCount - 1);
              queue.push(item);
              pauseQueue(delay);
            } else {
              item.reject(err);
            }
          })
          .finally(() => {
            runningCount--;
            process();
          });
      } else {
        const handler = jobHandlers[item.type];
        Promise.resolve()
          .then(() => {
            if (handler) return handler(item.payload);
            return Promise.reject(new Error(`No handler for job type: ${item.type}`));
          })
          .catch(() => {
            // Do not re-enqueue failed jobs; handler may have logged
          })
          .finally(() => {
            runningCount--;
            persist();
            process();
          });
      }
    }
  }

  return {
    enqueue<T>(fn: () => Promise<T>, priority: QueuePriority = "agent"): Promise<T> {
      if (queue.length >= maxQueueDepth) {
        return Promise.reject(new Error("Queue full"));
      }
      return new Promise<T>((resolve, reject) => {
        queue.push({
          kind: "fn",
          fn: fn as () => Promise<unknown>,
          priority,
          resolve: resolve as (value: unknown) => void,
          reject,
          retryCount: 0,
        });
        process();
      });
    },

    async enqueueJob(
      descriptor: { type: string; payload: Record<string, unknown> },
      priority: QueuePriority = "background"
    ): Promise<void> {
      if (queue.length >= maxQueueDepth) {
        throw new Error("Queue full");
      }
      const id = `job_${clock.now().getTime()}_${Math.random().toString(36).slice(2, 10)}`;
      const createdAt = clock.timestamp();
      queue.push({
        kind: "job",
        id,
        type: descriptor.type,
        priority,
        payload: descriptor.payload,
        createdAt,
      });
      await persist();
      process();
    },

    async loadFromFile(): Promise<void> {
      if (!persistPath || !fs) return;
      try {
        const exists = await fs.exists(persistPath);
        if (!exists) return;
        const raw = await fs.readFile(persistPath);
        const parsed = JSON.parse(raw) as JobDescriptor[];
        if (!Array.isArray(parsed)) return;
        for (const job of parsed) {
          if (job.id && job.type && job.priority && job.payload && job.createdAt) {
            queue.push({
              kind: "job",
              id: job.id,
              type: job.type,
              priority: job.priority as QueuePriority,
              payload: job.payload,
              createdAt: job.createdAt,
            });
          }
        }
        await fs.writeFile(persistPath, "[]");
        process();
      } catch {
        // Best-effort; do not throw
      }
    },

    depth(): number {
      return queue.length;
    },

    running(): number {
      return runningCount;
    },

    isPaused(): boolean {
      return paused;
    },
  };
}
