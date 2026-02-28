/**
 * @fileoverview Priority queue for LLM and embedding work. Jobs are JSON-like objects with
 * tool name and args. Priority is derived from the tool and who is enqueueing (caller).
 * @module lib/queue/llm-queue
 *
 * @note Concurrency is 1 (single worker) to avoid rate limits and ensure predictable ordering.
 */

import type { AppContext } from "../context";
import { globalEventBus } from "../events";

/** Who is enqueueing the job; used with tool to derive priority. */
export type QueueCaller = "system" | "user" | "maia" | "agent";

/**
 * Job structure: tool to call and its args. Args may include non-serializable values (e.g. callbacks).
 * Use "executeTool" to run any registered agent or custom tool by name.
 * @example
 * { tool: "refreshEmbeddings", args: {}, caller: "system" }
 * { tool: "runAgent", args: { agentId: "maia", sessionId: "...", message: "..." }, caller: "maia" }
 * { tool: "executeTool", args: { toolName: "knowledge_search", toolArgs: { query: "..." } }, caller: "agent" }
 */
export interface QueueJob {
  /** Tool/operation to execute (e.g. refreshEmbeddings, runAgent, extractSearchQueries). */
  tool: string;
  /** Arguments for the tool. May include functions (e.g. onEvent for streaming). */
  args: Record<string, unknown>;
  /** Who is enqueueing; used with tool to derive priority. */
  caller?: QueueCaller;
  /** When caller is "agent", the agent id (e.g. for runAgent from message_send). */
  callerAgentId?: string;
  /** Override derived priority. For tests only. */
  priority?: QueuePriority;
}

/** Priority levels: 1 = highest (embedding), 5 = lowest (other agents). */
export type QueuePriority = 1 | 2 | 3 | 4 | 5;

/** Tool handler: receives ctx and args, returns result. */
export type ToolHandler = (
  ctx: AppContext,
  args: Record<string, unknown>,
) => Promise<unknown>;

interface PendingJob {
  job: QueueJob;
  getContext: () => AppContext;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

const PRIORITY_COUNT = 5;
const queues: PendingJob[][] = Array.from({ length: PRIORITY_COUNT }, () => []);
let processing = false;
let embeddingReady = false;
let handlerRegistry: Map<string, ToolHandler> = new Map();
let processorIntervalId: ReturnType<typeof setInterval> | null = null;
let _handlersRegistered = false;

/** Promise for one-time lazy handler registration. Resolves when handlers are ready. */
let _handlersInitPromise: Promise<void> | null = null;

/**
 * Ensures tool handlers are registered in this module instance. Call before processing any job.
 * Lazy-initializes on first use so whichever chunk first calls enqueue() gets handlers in that same instance.
 * @internal
 */
async function ensureHandlersRegistered(): Promise<void> {
  if (_handlersRegistered) return;
  if (_handlersInitPromise) {
    await _handlersInitPromise;
    return;
  }
  _handlersInitPromise = (async () => {
    const { registerLlmQueueHandlers } = await import("./llm-queue-handlers");
    registerLlmQueueHandlers();
    _handlersRegistered = true;
  })();
  await _handlersInitPromise;
}

/**
 * Returns true if any priority queue has pending jobs.
 * @internal
 */
function hasPendingJobs(): boolean {
  return queues.some((q) => q.length > 0);
}

/**
 * Emits queue_changed SSE event so clients can update without polling.
 * @internal
 */
function emitQueueChanged(): void {
  try {
    globalEventBus.emit({ event: "queue_changed", data: { jobs: getQueueSnapshot() } });
  } catch {
    /* ignore */
  }
}

/**
 * Registers a tool handler for the queue. Call during startup before any jobs are processed.
 * Custom tools can be registered to support domain-specific operations that flow through the queue.
 * @param tool - Tool name (used in job.tool when enqueueing)
 * @param handler - Async function (ctx, args) => result
 * @example
 * registerToolHandler("myCustomOp", async (ctx, args) => {
 *   const input = args.input as string;
 *   return await doSomething(ctx, input);
 * });
 * // Later: enqueue({ tool: "myCustomOp", args: { input: "..." }, caller: "maia" }, getContext);
 */
export function registerToolHandler(tool: string, handler: ToolHandler): void {
  handlerRegistry.set(tool, handler);
}

/**
 * Marks handlers as registered. Called by registerLlmQueueHandlers so that explicit
 * registration (e.g. from tests or instrumentation) is recognized and enqueue does not
 * trigger a redundant lazy load.
 * @internal
 */
export function _markHandlersRegistered(): void {
  _handlersRegistered = true;
}

/**
 * Derives priority from tool and caller.
 * Embedding tools (p1) > smart context (p2) > user runAgent (p3) > maia runAgent (p4) > agent runAgent (p5).
 */
export function getPriority(job: QueueJob): QueuePriority {
  if (job.priority != null) return job.priority;
  const caller = job.caller ?? "agent";
  const tool = job.tool;

  const embeddingTools = [
    "refreshEmbeddings",
    "runKnowledgeIndex",
    "buildRawRetrievedContext",
    "indexHistoryEntry",
    "rebuildEmbeddings",
    "buildEmbeddings",
  ];
  if (embeddingTools.includes(tool)) return 1;

  const smartContextTools = [
    "extractSearchQueries",
    "filterRelevantSources",
    "summarizeRetrievedContext",
  ];
  if (smartContextTools.includes(tool)) return 2;

  if (tool === "runAgent" || tool === "executeTool") {
    if (caller === "user") return 3;
    if (caller === "maia") return 4;
    return 5;
  }

  return 5;
}

/**
 * Heartbeat: if queue has items and we're idle, kick off processing.
 * Runs at most once per second; does nothing while a job is processing.
 * @internal
 */
function heartbeat(): void {
  if (processing) return;
  if (!hasPendingJobs()) return;
  processing = true;
  void processNext();
}

/**
 * Runs the queue heartbeat once: if the queue has pending jobs and no job is currently
 * processing, starts processing the next job. Use from request handlers (e.g. ensureAppContext
 * or GET /api/queue) so the queue is ticked even when the timer from startQueueProcessor
 * does not run in the same process (e.g. dev workers or serverless).
 * @note Safe to call from any context; no-op when busy or queue empty.
 */
export function tickQueueProcessor(): void {
  heartbeat();
}

/**
 * Starts the queue processor heartbeat. Call once at startup (e.g. from instrumentation).
 * Runs every intervalMs; when idle and queue has items, processes the next job.
 * @param intervalMs - How often to check (default 1000). Use shorter values for tests.
 */
export function startQueueProcessor(intervalMs = 1000): void {
  if (processorIntervalId != null) return;
  processorIntervalId = setInterval(heartbeat, intervalMs);
}

/**
 * Stops the queue processor heartbeat. For use in tests only.
 * @internal
 */
export function _stopQueueProcessorForTests(): void {
  if (processorIntervalId != null) {
    clearInterval(processorIntervalId);
    processorIntervalId = null;
  }
}

/**
 * Processes the next job in priority order.
 * @internal
 */
async function processNext(): Promise<void> {
  for (let p = 0; p < PRIORITY_COUNT; p++) {
    const pending = queues[p].shift();
    if (pending) {
      const { job, getContext, resolve, reject } = pending;
      const handler = handlerRegistry.get(job.tool);
      if (!handler) {
        reject(new Error(`Unknown queue tool: ${job.tool}`));
      } else {
        try {
          const ctx = getContext();
          const result = await handler(ctx, job.args);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }
      emitQueueChanged();
      queueMicrotask(() => void processNext());
      return;
    }
  }
  processing = false;
}

/**
 * Performs the actual enqueue (push + trigger). Used after handlers are ensured.
 * @internal
 */
function doEnqueue<T>(
  job: QueueJob,
  getContext: () => AppContext,
  resolve: (value: T) => void,
  reject: (err: unknown) => void,
): void {
  const priority = getPriority(job);
  const p = priority - 1;
  queues[p].push({
    job,
    getContext,
    resolve: resolve as (v: unknown) => void,
    reject,
  });
  emitQueueChanged();
  if (processorIntervalId == null) {
    startQueueProcessor(1000);
  }
  if (typeof setImmediate !== "undefined") {
    setImmediate(() => heartbeat());
  } else {
    setTimeout(() => heartbeat(), 0);
  }
  if (!processing) {
    processing = true;
    queueMicrotask(() => void processNext());
  }
}

/**
 * Enqueues a job. Returns a promise that resolves when the job completes.
 * Priority is derived from tool and caller.
 * Lazy-registers handlers on first use so whichever module instance receives enqueue has handlers.
 * Triggers heartbeat via setImmediate so processing starts after the current sync block.
 * @param job - Job object with tool, args, and optional caller
 * @param getContext - Function to obtain AppContext when the job runs (avoids passing ctx at enqueue time)
 * @returns Promise that resolves with the job result
 */
export function enqueue<T = unknown>(
  job: QueueJob,
  getContext: () => AppContext,
): Promise<T> {
  if (_handlersRegistered) {
    return new Promise<T>((resolve, reject) => {
      doEnqueue(job, getContext, resolve, reject);
    });
  }
  return ensureHandlersRegistered().then(
    () =>
      new Promise<T>((resolve, reject) => {
        doEnqueue(job, getContext, resolve, reject);
      }),
  );
}

/**
 * Creates a display-safe copy of args (replaces functions with a placeholder).
 * @internal
 */
function sanitizeArgsForDisplay(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "function") {
      out[k] = "[fn]";
    } else if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = sanitizeArgsForDisplay(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "object" && item !== null && !(item instanceof Date)
          ? sanitizeArgsForDisplay(item as Record<string, unknown>)
          : typeof item === "function"
            ? "[fn]"
            : item,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Snapshot of a single queued job for display.
 */
export interface QueueJobSnapshot {
  tool: string;
  args: Record<string, unknown>;
  caller?: QueueCaller;
  priority: QueuePriority;
}

/**
 * Returns a snapshot of all jobs currently in the queue, in priority order.
 * Args are sanitized (functions replaced with "[fn]") for safe serialization.
 */
export function getQueueSnapshot(): QueueJobSnapshot[] {
  const result: QueueJobSnapshot[] = [];
  for (let p = 0; p < PRIORITY_COUNT; p++) {
    const priority = (p + 1) as QueuePriority;
    for (const pending of queues[p]) {
      result.push({
        tool: pending.job.tool,
        args: sanitizeArgsForDisplay(pending.job.args),
        caller: pending.job.caller,
        priority,
      });
    }
  }
  return result;
}

/**
 * Returns true if the initial embedding refresh has completed successfully.
 */
export function isEmbeddingReady(): boolean {
  return embeddingReady;
}

/**
 * Marks embedding as ready. Call after the first successful embedding refresh.
 * @internal
 */
export function setEmbeddingReady(): void {
  embeddingReady = true;
}

/**
 * Resets embedding-ready state. For use in tests only.
 * @internal
 */
export function _resetEmbeddingReadyForTests(): void {
  embeddingReady = false;
}

/**
 * Resets the queue state. For use in tests only.
 * Clears handlers and lazy-init state so tests can simulate a fresh module instance.
 * @internal
 */
export function _resetQueueForTests(): void {
  _stopQueueProcessorForTests();
  for (const q of queues) q.length = 0;
  processing = false;
  embeddingReady = false;
  handlerRegistry.clear();
  _handlersRegistered = false;
  _handlersInitPromise = null;
}
