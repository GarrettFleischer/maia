/**
 * @fileoverview Scheduler for hourly knowledge base reindex.
 * @module lib/knowledge/scheduler
 *
 * Runs once on startup, then every 60 minutes aligned to system time (:00 each hour).
 * Single-run guard to avoid overlap.
 */

import type { AppContext } from "../context";
import type { EmbeddingAdapter } from "./embedding";
import { runKnowledgeIndex } from "./index";
import { delayUntilNextBoundaryMs } from "../schedule-boundary";

const INTERVAL_MS = 60 * 60 * 1000;
const INTERVAL_MINUTES = 60;

let _initialTimeout: ReturnType<typeof setTimeout> | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;

/**
 * Run the knowledge index once. Safe to call while another run is in progress (skips).
 */
export async function runKnowledgeIndexOnce(
  ctx: AppContext,
  embedder: EmbeddingAdapter | undefined
): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    await runKnowledgeIndex(ctx, { embedder });
  } finally {
    _running = false;
  }
}

/**
 * Start the scheduler: run index once immediately, then every hour at :00 (system time).
 * Idempotent: does nothing if already started.
 */
export function startKnowledgeScheduler(
  ctx: AppContext,
  getEmbedder: () => EmbeddingAdapter | undefined
): void {
  if (_initialTimeout ?? _timer) return;

  runKnowledgeIndexOnce(ctx, getEmbedder()).catch((err) => {
    console.error("Knowledge index (startup) failed:", err);
  });

  const delayMs = delayUntilNextBoundaryMs(INTERVAL_MINUTES);
  _initialTimeout = setTimeout(() => {
    _initialTimeout = null;
    runKnowledgeIndexOnce(ctx, getEmbedder()).catch((err) => {
      console.error("Knowledge index (hourly) failed:", err);
    });
    _timer = setInterval(() => {
      runKnowledgeIndexOnce(ctx, getEmbedder()).catch((err) => {
        console.error("Knowledge index (hourly) failed:", err);
      });
    }, INTERVAL_MS);
  }, delayMs);

  console.log("Knowledge index scheduler started (every 60 min at :00)");
}

/**
 * Stop the scheduler. Used in tests.
 */
export function stopKnowledgeScheduler(): void {
  if (_initialTimeout) {
    clearTimeout(_initialTimeout);
    _initialTimeout = null;
  }
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
