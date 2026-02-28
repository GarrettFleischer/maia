/**
 * @fileoverview API route for LLM queue snapshot (tool, args, caller per job).
 * @module app/api/queue/route
 *
 * Exposes the current queue contents for the header queue monitor.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { getQueueSnapshot, startQueueProcessor, tickQueueProcessor } from "@/lib/queue/llm-queue";

/**
 * GET /api/queue
 * @brief Returns a snapshot of all jobs in the LLM queue.
 * @param _req - NextRequest (unused)
 * @returns JSON payload with jobs array: [{ tool, args, caller?, priority }]
 */
export async function GET(_req: NextRequest) {
  await ensureAppContext();
  startQueueProcessor(1000);
  tickQueueProcessor();
  const jobs = getQueueSnapshot();
  return NextResponse.json(
    { jobs },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
