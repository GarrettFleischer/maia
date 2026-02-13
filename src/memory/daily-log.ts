/**
 * @fileoverview Tier 1: Daily log for timestamped append-only entries per day.
 * @module memory/daily-log
 * @brief Provides read/write access to daily markdown files at {basePath}/{YYYY-MM-DD}.md.
 */

import type { AuditLog, Clock, FileSystem } from "../core/types.js";

/** @brief Dependencies for createDailyLog */
export interface DailyLogDeps {
  fs: FileSystem;
  clock: Clock;
  auditLog: AuditLog;
  basePath: string;
}

/** @brief Daily log interface */
export interface DailyLog {
  /** Append content to today's file with timestamp prefix */
  append(content: string): Promise<void>;
  /** Read today's file (empty string if not exists) */
  readToday(): Promise<string>;
  /** Read yesterday's file */
  readYesterday(): Promise<string>;
  /** Read specific date's file (YYYY-MM-DD) */
  readDate(date: string): Promise<string>;
}

/**
 * @brief Parses YYYY-MM-DD and subtracts one day.
 * @param dateStr - Date string in YYYY-MM-DD format
 * @returns Yesterday's date as YYYY-MM-DD
 */
function yesterdayString(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - 1);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * @brief Creates a daily log instance.
 * @param deps - Dependencies: fs, clock, auditLog, basePath
 * @returns DailyLog interface
 */
export function createDailyLog(deps: DailyLogDeps): DailyLog {
  const { fs, clock, auditLog, basePath } = deps;

  function filePath(date: string): string {
    return `${basePath}/${date}.md`;
  }

  return {
    async append(content: string): Promise<void> {
      const today = clock.todayString();
      const path = filePath(today);
      const now = clock.now();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const line = `\n[${hh}:${mm}] ${content}\n`;
      const exists = await fs.exists(path);
      if (!exists) {
        try {
          await fs.mkdir(basePath);
        } catch {
          /* directory may already exist */
        }
      }
      await fs.appendFile(path, line);
      await auditLog.log("MEMORY_WRITE", { path, action: "append" });
    },

    async readToday(): Promise<string> {
      const today = clock.todayString();
      return readFileSafe(filePath(today));
    },

    async readYesterday(): Promise<string> {
      const today = clock.todayString();
      const yesterday = yesterdayString(today);
      return readFileSafe(filePath(yesterday));
    },

    async readDate(date: string): Promise<string> {
      return readFileSafe(filePath(date));
    },
  };

  async function readFileSafe(path: string): Promise<string> {
    const exists = await fs.exists(path);
    if (!exists) return "";
    try {
      return await fs.readFile(path);
    } catch {
      return "";
    }
  }
}
