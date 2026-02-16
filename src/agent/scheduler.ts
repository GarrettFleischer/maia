/**
 * @fileoverview Scheduler for managing scheduled tasks and reminders. Persists
 * tasks to disk and supports adding, removing, listing, and marking tasks complete.
 * Includes cron parsing and a polling loop for daemon mode.
 * @module agent/scheduler
 */

import type {
  FileSystem,
  Clock,
  Logger,
  ScheduledTask,
  TaskStatus,
} from "../core/types.js";

/** @brief Dependencies for createScheduler */
export interface SchedulerDeps {
  fs: FileSystem;
  clock: Clock;
  schedulerPath: string;
  logger?: Logger;
  /** Polling interval in milliseconds (default: 60000) */
  checkIntervalMs?: number;
}

/** @brief Input for adding a new scheduled task */
export interface AddTaskInput {
  schedule: string;
  prompt: string;
  channel: string;
  /** Optional agent ID this task belongs to */
  agentId?: string;
}

/**
 * @brief Handler called when a scheduled task becomes due.
 * @param task - The due task
 */
export type TaskDueHandler = (task: ScheduledTask & { agentId?: string }) => Promise<void>;

/** @brief Scheduler interface */
export interface Scheduler {
  add(task: AddTaskInput): Promise<ScheduledTask>;
  remove(id: string): Promise<void>;
  list(): Promise<ScheduledTask[]>;
  getDueTasks(): Promise<ScheduledTask[]>;
  markCompleted(id: string): Promise<void>;
  /**
   * @brief Starts the polling loop. Calls the handler for each due task.
   * @param handler - Function to call when a task is due
   */
  start(handler: TaskDueHandler): void;
  /**
   * @brief Stops the polling loop.
   */
  stop(): void;
}

/**
 * @brief Generates a random hex string for task IDs.
 * @returns A 32-character hex string
 */
function randomHexId(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * @brief Checks if a string is a valid ISO timestamp (not cron).
 * @param schedule - The schedule string to check
 * @returns True if it looks like an ISO timestamp
 */
function isIsoTimestamp(schedule: string): boolean {
  if (typeof schedule !== "string") return false;
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
  return isoRegex.test(schedule.trim());
}

/**
 * @brief Extracts a schedule string from a value that may be a string or an object (cron, expression, value, schedule, scheduledAt).
 * @param scheduleRaw - Schedule as string or object
 * @returns Schedule string or undefined if none found
 */
export function scheduleToString(scheduleRaw: unknown): string | undefined {
  if (typeof scheduleRaw === "string") return scheduleRaw;
  if (scheduleRaw === null || typeof scheduleRaw !== "object") return undefined;
  const obj = scheduleRaw as Record<string, unknown>;
  if (typeof obj.cron === "string") return obj.cron;
  if (typeof obj.expression === "string") return obj.expression;
  if (typeof obj.value === "string") return obj.value;
  if (typeof obj.schedule === "string") return obj.schedule;
  if (typeof obj.scheduledAt === "string") return obj.scheduledAt;
  return undefined;
}

/**
 * @brief Normalizes a raw task from JSON so schedule is always a string.
 * Handles legacy or malformed data where schedule was persisted as an object.
 * @param raw - Parsed task (schedule may be string or object)
 * @param logger - Optional logger for reporting normalized/dropped schedules
 * @returns Normalized task with schedule as string, or null if task is invalid
 */
function normalizeLoadedTask(
  raw: Record<string, unknown> & { id: string; schedule?: unknown; prompt?: string; channel?: string; status?: string; createdAt?: string; lastRunAt?: string },
  logger?: Logger
): (ScheduledTask & { agentId?: string }) | null {
  const id = raw.id;
  const scheduleRaw = raw.schedule;

  const schedule = scheduleToString(scheduleRaw);
  if (schedule === undefined) {
    if (scheduleRaw !== null && typeof scheduleRaw === "object") {
      logger?.warn("Scheduler skipping task with non-string schedule (unable to extract string)", {
        taskId: id,
        scheduleType: "object",
      });
    } else {
      logger?.warn("Scheduler skipping task with invalid schedule type", {
        taskId: id,
        scheduleType: typeof scheduleRaw,
      });
    }
    return null;
  }
  if (typeof scheduleRaw === "object" && scheduleRaw !== null) {
    logger?.debug("Scheduler normalized task schedule from object to string", { taskId: id });
  }

  return {
    id,
    schedule,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    channel: typeof raw.channel === "string" ? raw.channel : "",
    status: (raw.status === "pending" || raw.status === "running" || raw.status === "completed" || raw.status === "failed" ? raw.status : "pending") as TaskStatus,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
    lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : undefined,
    agentId: typeof raw.agentId === "string" ? raw.agentId : undefined,
  };
}

/**
 * @brief Creates a scheduler for managing scheduled tasks.
 * @param deps - Dependencies: fs, clock, schedulerPath
 * @returns Scheduler instance with add, remove, list, getDueTasks,
 *   and markCompleted methods
 */
/**
 * @brief Parses a simple cron expression (minute hour dayOfMonth month dayOfWeek).
 * @param cron - Cron string like "0 9 * * *"
 * @param now - Current date
 * @returns true if the cron matches the current minute
 *
 * @note Supports: exact numbers, * (any), and step values (e.g. *\/5).
 * Does not support ranges or lists.
 */
function cronMatchesNow(cron: string, now: Date): boolean {
  if (typeof cron !== "string") return false;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const fields = [
    now.getMinutes(),   // minute
    now.getHours(),     // hour
    now.getDate(),      // day of month
    now.getMonth() + 1, // month (1-based)
    now.getDay(),       // day of week (0=Sunday)
  ];

  for (let i = 0; i < 5; i++) {
    const part = parts[i];
    if (part === "*") continue;

    // Step values: */5 means every 5
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) return false;
      if (fields[i] % step !== 0) return false;
      continue;
    }

    // Exact value
    const val = parseInt(part, 10);
    if (isNaN(val)) return false;
    if (fields[i] !== val) return false;
  }

  return true;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { fs, clock, schedulerPath, logger, checkIntervalMs = 60000 } = deps;
  const tasks = new Map<string, ScheduledTask & { agentId?: string }>();
  let loaded = false;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const exists = await fs.exists(schedulerPath);
      if (exists) {
        const content = await fs.readFile(schedulerPath);
        const parsed = JSON.parse(content) as Record<string, unknown>[];
        let changed = false;
        for (const raw of parsed) {
          if (!raw || typeof raw !== "object" || typeof raw.id !== "string") continue;
          const task = normalizeLoadedTask(
            raw as Parameters<typeof normalizeLoadedTask>[0],
            logger
          );
          if (task) {
            tasks.set(task.id, task);
            if (typeof (raw as { schedule?: unknown }).schedule !== "string") {
              changed = true; // was normalized from object to string
            }
          } else {
            changed = true; // dropped invalid task
          }
        }
        if (changed) await persist();
      }
    } catch {
      // File may not exist or be invalid; start fresh
    }
  }

  async function persist(): Promise<void> {
    const all = Array.from(tasks.values());
    const content = JSON.stringify(all, null, 2);
    const lastSep = Math.max(
      schedulerPath.lastIndexOf("/"),
      schedulerPath.lastIndexOf("\\")
    );
    if (lastSep > 0) {
      const dir = schedulerPath.slice(0, lastSep);
      try {
        await fs.mkdir(dir);
      } catch {
        /* directory may already exist */
      }
    }
    await fs.writeFile(schedulerPath, content);
  }

  return {
    async add(task: AddTaskInput): Promise<ScheduledTask> {
      await ensureLoaded();
      const scheduleStr = scheduleToString(task.schedule);
      if (scheduleStr === undefined) {
        logger?.warn("Scheduler add: schedule must be a string or object with cron/expression/value/schedule/scheduledAt", {
          scheduleType: typeof task.schedule,
        });
        throw new Error("Invalid schedule: expected string or object with extractable schedule");
      }
      const id = randomHexId();
      const now = clock.now().toISOString();
      const scheduled: ScheduledTask & { agentId?: string } = {
        id,
        schedule: scheduleStr,
        prompt: task.prompt,
        channel: task.channel,
        status: "pending",
        createdAt: now,
        agentId: task.agentId,
      };
      tasks.set(id, scheduled);
      await persist();
      return scheduled;
    },

    async remove(id: string): Promise<void> {
      await ensureLoaded();
      tasks.delete(id);
      await persist();
    },

    async list(): Promise<ScheduledTask[]> {
      await ensureLoaded();
      return Array.from(tasks.values());
    },

    async getDueTasks(): Promise<ScheduledTask[]> {
      await ensureLoaded();
      const now = clock.now();
      const nowIso = now.toISOString();
      const due: ScheduledTask[] = [];
      for (const task of tasks.values()) {
        if (task.status !== "pending") continue;
        if (typeof task.schedule !== "string") {
          logger?.warn("Scheduler skipping task with non-string schedule", {
            taskId: task.id,
            scheduleType: typeof task.schedule,
          });
          continue;
        }

        // ISO timestamp: one-shot task
        if (isIsoTimestamp(task.schedule)) {
          if (task.schedule <= nowIso) {
            due.push(task);
          }
          continue;
        }

        // Cron expression: recurring task
        if (cronMatchesNow(task.schedule, now)) {
          // Prevent re-triggering within the same minute
          if (task.lastRunAt) {
            const lastRun = new Date(task.lastRunAt);
            if (
              lastRun.getFullYear() === now.getFullYear() &&
              lastRun.getMonth() === now.getMonth() &&
              lastRun.getDate() === now.getDate() &&
              lastRun.getHours() === now.getHours() &&
              lastRun.getMinutes() === now.getMinutes()
            ) {
              continue; // Already ran this minute
            }
          }
          due.push(task);
        }
      }
      return due;
    },

    async markCompleted(id: string): Promise<void> {
      await ensureLoaded();
      const task = tasks.get(id);
      if (!task) {
        throw new Error(`Unknown task: ${id}`);
      }

      const nowIso = clock.now().toISOString();
      task.lastRunAt = nowIso;

      // One-shot (ISO) tasks become completed; cron tasks stay pending for next run
      if (isIsoTimestamp(task.schedule)) {
        task.status = "completed" as TaskStatus;
      }
      // Cron tasks remain "pending" but lastRunAt is updated to prevent re-trigger

      await persist();
    },

    start(handler: TaskDueHandler): void {
      if (pollInterval) return; // Already running

      logger?.info("Scheduler polling started", { intervalMs: checkIntervalMs });

      const tick = async () => {
        try {
          const dueTasks = await this.getDueTasks();
          for (const task of dueTasks) {
            try {
              await handler(task as ScheduledTask & { agentId?: string });
              await this.markCompleted(task.id);
            } catch (err) {
              logger?.warn("Scheduler task handler failed", {
                taskId: task.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch (err) {
          logger?.warn("Scheduler tick failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      // Run once immediately, then on interval
      tick();
      pollInterval = setInterval(tick, checkIntervalMs);
    },

    stop(): void {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        logger?.info("Scheduler polling stopped");
      }
    },
  };
}
