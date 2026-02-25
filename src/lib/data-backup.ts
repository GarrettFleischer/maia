/**
 * @fileoverview Git-based backups for the Maia data directory.
 * @module lib/data-backup
 *
 * Runs `git status`, `git add`, and `git commit` inside the data directory
 * to capture changes as lightweight heartbeat backups.
 */

import type { AppContext } from "./context";
import { getDataDir } from "./data-dir";

const GIT_TIMEOUT_MS = 10_000;

/**
 * @brief Runs a single git-based backup of the data directory.
 * @param ctx Application context providing the process runner.
 * @returns Promise that resolves when the backup has completed or been skipped.
 * @note Backup is skipped when the data directory is not a git repository or has no changes.
 * @example
 * await runDataBackup(ctx);
 */
export async function runDataBackup(ctx: AppContext): Promise<void> {
  const dataDir = getDataDir();

  const statusResult = await ctx.processRunner.exec("git status --porcelain", {
    cwd: dataDir,
    timeout: GIT_TIMEOUT_MS,
  });

  if (statusResult.exitCode !== 0) {
    // Not a git repository or git is unavailable — skip backup rather than failing the heartbeat.
    return;
  }

  if (statusResult.stdout.trim() === "") {
    // No changes to commit.
    return;
  }

  const addResult = await ctx.processRunner.exec("git add -A", {
    cwd: dataDir,
    timeout: GIT_TIMEOUT_MS,
  });

  if (addResult.exitCode !== 0) {
    // Staging failed; do not attempt a commit.
    return;
  }

  const timestamp = new Date().toISOString();
  const message = `heartbeat backup ${timestamp}`;

  await ctx.processRunner.exec(`git commit -m "${message}"`, {
    cwd: dataDir,
    timeout: GIT_TIMEOUT_MS,
  });
}

