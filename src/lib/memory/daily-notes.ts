/**
 * @fileoverview Dated operational notes under the agent directory (daily timeline).
 * @module lib/memory/daily-notes
 */

import path from "path";
import { getAgentDir } from "../data-dir";
import type { AppContext } from "../context";

/**
 * @brief Directory for daily markdown files.
 * @param agentId Agent id
 */
export function getDailyNotesDir(fs: AppContext["fs"], agentId: string): string {
  const dir = path.join(getAgentDir(agentId), "memory", "daily");
  if (!fs.exists(dir)) fs.mkdirp(dir);
  return dir;
}

/**
 * @brief Path to YYYY-MM-DD.md
 * @param agentId Agent id
 * @param isoDate Date string (date portion used)
 */
export function dailyNotePath(
  fs: AppContext["fs"],
  agentId: string,
  isoDate: string,
): string {
  const day = isoDate.slice(0, 10);
  return path.join(getDailyNotesDir(fs, agentId), `${day}.md`);
}

/**
 * @brief Read daily note or empty string.
 * @param ctx App context
 * @param agentId Agent id
 * @param isoDate Date
 */
export function readDailyNote(
  ctx: AppContext,
  agentId: string,
  isoDate: string,
): string {
  const p = dailyNotePath(ctx.fs, agentId, isoDate);
  if (!ctx.fs.exists(p)) return "";
  try {
    return ctx.fs.readFile(p);
  } catch {
    return "";
  }
}

/**
 * @brief Append a markdown block with timestamp header.
 * @param ctx App context
 * @param agentId Agent id
 * @param isoDate Date key for file
 * @param section Text to append
 */
export function appendDailyNote(
  ctx: AppContext,
  agentId: string,
  isoDate: string,
  section: string,
): void {
  const p = dailyNotePath(ctx.fs, agentId, isoDate);
  const stamp = new Date().toISOString();
  const block = `\n\n## ${stamp}\n\n${section.trim()}\n`;
  const prev = ctx.fs.exists(p) ? ctx.fs.readFile(p) : `# Daily log ${isoDate.slice(0, 10)}\n`;
  ctx.fs.writeFile(p, prev + block);
}
