/**
 * @fileoverview API route for Ollama performance metrics (host, processes, and jobs).
 * @module app/api/ollama/metrics/route
 *
 * Exposes lightweight system-level metrics used by the header performance monitor.
 */

import os from "os";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ensureAppContext } from "@/instrumentation";
import { getSettings } from "@/lib/settings";
import { listOllamaJobs } from "@/lib/ollama/jobs";

interface OllamaPsModel {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
}

interface OllamaPsResponse {
  models?: OllamaPsModel[];
}

interface HostMetrics {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
}

interface ProcessMetrics {
  name: string;
  vramBytes: number;
  totalSizeBytes: number;
}

/**
 * Computes coarse-grained host CPU and memory metrics.
 * @brief Derives CPU load percentage and memory usage from Node's os and process modules.
 * @returns HostMetrics with CPU percentage and memory usage.
 */
function getHostMetrics(): HostMetrics {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);

  const loadAverages = os.loadavg();
  const oneMinuteLoad = loadAverages[0] ?? 0;
  const cpuCount = Math.max(1, os.cpus().length || 1);
  const cpuPercent = Math.max(0, Math.min(100, (oneMinuteLoad / cpuCount) * 100));

  return {
    cpuPercent,
    memoryUsedBytes: usedMem,
    memoryTotalBytes: totalMem,
  };
}

/**
 * Maps the Ollama /api/ps response into compact process metrics.
 * @param body - Parsed JSON body from /api/ps
 * @returns Array of process metrics suitable for the header monitor.
 */
function mapPsToProcessMetrics(body: OllamaPsResponse): ProcessMetrics[] {
  const models = Array.isArray(body.models) ? body.models : [];
  return models.map((m) => ({
    name: typeof m.name === "string" && m.name.length > 0
      ? m.name
      : typeof m.model === "string"
        ? m.model
        : "unknown",
    vramBytes: typeof m.size_vram === "number" ? m.size_vram : 0,
    totalSizeBytes: typeof m.size === "number" ? m.size : 0,
  }));
}

/**
 * GET /api/ollama/metrics
 * @brief Returns host, Ollama process, and application-level job metrics.
 * @param _req - NextRequest (unused, reserved for future filtering)
 * @returns JSON payload consumed by the OllamaPerformanceMonitor component.
 */
export async function GET(_req: NextRequest) {
  const ctx = await ensureAppContext();
  const settings = getSettings(ctx);
  const host = getHostMetrics();

  const baseUrl = (settings.ollamaBaseUrl ?? "").replace(/\/+$/, "");
  const psUrl = `${baseUrl}/api/ps`;

  let psBody: OllamaPsResponse | null = null;

  try {
    const resp = await ctx.http.fetch(psUrl, { method: "GET" });
    if (!resp.ok) {
      return NextResponse.json(
        { error: "Failed to query Ollama /api/ps" },
        { status: 503 },
      );
    }
    const raw = await resp.json();
    psBody = (raw ?? {}) as OllamaPsResponse;
  } catch {
    return NextResponse.json(
      { error: "Error calling Ollama /api/ps" },
      { status: 503 },
    );
  }

  const processes = mapPsToProcessMetrics(psBody ?? {});
  const jobs = listOllamaJobs();

  return NextResponse.json(
    { host, processes, jobs },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

