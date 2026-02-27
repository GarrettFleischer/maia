/**
 * @fileoverview API route to request cancellation of an Ollama-backed job by id.
 * @module app/api/ollama/jobs/stop/route
 *
 * @brief Accepts a job id and asks the in-memory job registry to cancel that job.
 */

import { NextRequest, NextResponse } from "next/server";
import { cancelOllamaJob } from "@/lib/ollama/jobs";

interface StopJobBody {
  jobId?: string;
}

/**
 * POST /api/ollama/jobs/stop
 * @brief Cancels a running Ollama-backed job tracked in the job registry.
 * @param req - NextRequest containing JSON body with jobId
 * @returns 200 when cancellation requested, 404 when job not found or not cancellable, 400 for invalid body.
 * @note This route cancels application-level jobs only; it does not forcibly kill Ollama processes.
 */
export async function POST(req: NextRequest) {
  let body: StopJobBody;
  try {
    body = (await req.json()) as StopJobBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  if (!body.jobId || typeof body.jobId !== "string") {
    return NextResponse.json(
      { error: "jobId is required" },
      { status: 400 },
    );
  }

  const cancelled = cancelOllamaJob(body.jobId);
  if (!cancelled) {
    return NextResponse.json(
      { error: "Job not found or not cancellable" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}

