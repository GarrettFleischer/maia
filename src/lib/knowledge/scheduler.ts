/**
 * @fileoverview Scheduler for hourly knowledge base reindex.
 * @module lib/knowledge/scheduler
 *
 * Runs once on startup and then every 60 minutes. Single-run guard to avoid overlap.
 */

import type { AppContext } from "../context";
import type { EmbeddingAdapter } from "./embedding";
import { runKnowledgeIndex } from "./index";

const INTERVAL_MS = 60 * 60 * 1000;

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
 * Start the scheduler: run index once immediately, then every hour.
 * Idempotent: does nothing if already started.
 */
export function startKnowledgeScheduler(
  ctx: AppContext,
  getEmbedder: () => EmbeddingAdapter | undefined
): void {
  if (_timer) return;

  runKnowledgeIndexOnce(ctx, getEmbedder()).catch((err) => {
    console.error("Knowledge index (startup) failed:", err);
  });

  _timer = setInterval(() => {
    runKnowledgeIndexOnce(ctx, getEmbedder()).catch((err) => {
      console.error("Knowledge index (hourly) failed:", err);
    });
  }, INTERVAL_MS);

  console.log("Knowledge index scheduler started (every 60 min)");
}

/**
 * Stop the scheduler. Used in tests.
 */
export function stopKnowledgeScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
