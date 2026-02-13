/**
 * @fileoverview Scheduler for managing scheduled tasks and reminders. Persists
 * tasks to disk and supports adding, removing, listing, and marking tasks complete.
 * @module agent/scheduler
 */

import type {
  FileSystem,
  Clock,
  ScheduledTask,
  TaskStatus,
} from "../core/types.js";

/** @brief Dependencies for createScheduler */
export interface SchedulerDeps {
  fs: FileSystem;
  clock: Clock;
  schedulerPath: string;
}

/** @brief Input for adding a new scheduled task */
export interface AddTaskInput {
  schedule: string;
  prompt: string;
  channel: string;
}

/** @brief Scheduler interface */
export interface Scheduler {
  add(task: AddTaskInput): Promise<ScheduledTask>;
  remove(id: string): Promise<void>;
  list(): Promise<ScheduledTask[]>;
  getDueTasks(): Promise<ScheduledTask[]>;
  markCompleted(id: string): Promise<void>;
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
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
  return isoRegex.test(schedule.trim());
}

/**
 * @brief Creates a scheduler for managing scheduled tasks.
 * @param deps - Dependencies: fs, clock, schedulerPath
 * @returns Scheduler instance with add, remove, list, getDueTasks,
 *   and markCompleted methods
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { fs, clock, schedulerPath } = deps;
  const tasks = new Map<string, ScheduledTask>();
  let loaded = false;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const exists = await fs.exists(schedulerPath);
      if (exists) {
        const content = await fs.readFile(schedulerPath);
        const parsed = JSON.parse(content) as ScheduledTask[];
        for (const task of parsed) {
          tasks.set(task.id, task);
        }
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
      const id = randomHexId();
      const now = clock.now().toISOString();
      const scheduled: ScheduledTask = {
        id,
        schedule: task.schedule,
        prompt: task.prompt,
        channel: task.channel,
        status: "pending",
        createdAt: now,
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
      const now = clock.now().toISOString();
      const due: ScheduledTask[] = [];
      for (const task of tasks.values()) {
        if (task.status !== "pending") continue;
        if (!isIsoTimestamp(task.schedule)) continue;
        if (task.schedule <= now) {
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
      task.status = "completed" as TaskStatus;
      task.lastRunAt = clock.now().toISOString();
      await persist();
    },
  };
}
