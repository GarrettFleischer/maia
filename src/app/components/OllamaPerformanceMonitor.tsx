/**
 * @fileoverview Compact Ollama performance monitor widget for the app header.
 * @module app/components/OllamaPerformanceMonitor
 *
 * @brief Polls /api/ollama/metrics and renders a small summary plus expandable details (processes and jobs).
 */

"use client";

import { useEffect, useState, useCallback } from "react";

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

interface JobMetrics {
  id: string;
  model: string;
  type: string;
  startedAt: string;
  status: string;
  canStop: boolean;
}

interface MetricsPayload {
  host: HostMetrics;
  processes: ProcessMetrics[];
  jobs: JobMetrics[];
}

/**
 * Formats bytes as a human-readable RAM string in GB with one decimal place.
 * @param used - Used bytes
 * @param total - Total bytes
 * @returns Display string such as "12.0 GB / 32.0 GB"
 */
function formatRam(used: number, total: number): string {
  const gb = 1_000_000_000;
  const usedGb = used / gb;
  const totalGb = total / gb;
  return `${usedGb.toFixed(1)} GB / ${totalGb.toFixed(1)} GB`;
}

/**
 * Formats VRAM bytes as a human-readable GB string with one decimal place.
 * @param bytes - Number of bytes
 * @returns Display string such as "5.0 GB VRAM"
 */
function formatVram(bytes: number): string {
  const gb = 1_000_000_000;
  const valueGb = bytes / gb;
  return `${valueGb.toFixed(1)} GB VRAM`;
}

/**
 * @brief Header widget showing Ollama host, process, and job metrics with optional details panel.
 * @returns Compact React component suitable for placement in the top-right header area.
 */
export default function OllamaPerformanceMonitor() {
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [isStopping, setIsStopping] = useState<Record<string, boolean>>({});

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch("/api/ollama/metrics");
      if (!res.ok) {
        setError("Ollama metrics unavailable");
        setMetrics(null);
        return;
      }
      const body = (await res.json()) as MetricsPayload;
      setMetrics(body);
      setError(null);
    } catch {
      setError("Ollama metrics unavailable");
      setMetrics(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      await fetchMetrics();
    };

    void load();

    const id = setInterval(() => {
      if (!cancelled) {
        void load();
      }
    }, 10_000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fetchMetrics]);

  /**
   * Issues a stop request for the given job id via /api/ollama/jobs/stop.
   * @param jobId - Identifier of the job to cancel
   * @returns Promise that resolves when the request completes.
   */
  const handleStopJob = useCallback(async (jobId: string): Promise<void> => {
    setIsStopping((prev) => ({ ...prev, [jobId]: true }));
    try {
      await fetch("/api/ollama/jobs/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      await fetchMetrics();
    } catch {
      // Swallow errors; global header should remain stable even if stop fails.
    } finally {
      setIsStopping((prev) => ({ ...prev, [jobId]: false }));
    }
  }, [fetchMetrics]);

  const host = metrics?.host;
  const processCount = metrics?.processes.length ?? 0;
  const totalVramBytes =
    metrics?.processes.reduce((sum, p) => sum + p.vramBytes, 0) ?? 0;
  const totalSizeBytes =
    metrics?.processes.reduce((sum, p) => sum + p.totalSizeBytes, 0) ?? 0;
  /** GPU % derived from size_vram/size (Ollama issue #10760 workaround). */
  const gpuPercent =
    totalSizeBytes > 0
      ? Math.round((totalVramBytes / totalSizeBytes) * 100)
      : null;

  return (
    <div className="flex items-center">
      <button
        type="button"
        aria-label="Ollama metrics"
        className="flex flex-col items-start px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900 text-left"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="text-[11px] font-medium text-zinc-200">Ollama metrics</span>
        {error && (
          <span className="text-[10px] text-red-400">
            Ollama metrics unavailable
          </span>
        )}
        {!error && !metrics && (
          <span className="text-[10px] text-zinc-500">Loading Ollama…</span>
        )}
        {!error && metrics && host && (
          <span className="text-[10px] text-zinc-400">
            {processCount} models • GPU{" "}
            {gpuPercent !== null ? `${gpuPercent}%` : "—"} (
            {formatVram(totalVramBytes)}) • CPU {Math.round(host.cpuPercent)}% • RAM{" "}
            {formatRam(host.memoryUsedBytes, host.memoryTotalBytes)}
          </span>
        )}
      </button>

      {expanded && (
        <div className="absolute right-4 top-14 z-20 w-72 rounded-lg border border-zinc-800 bg-zinc-950 shadow-lg p-3 space-y-3">
          {metrics && metrics.processes.length > 0 ? (
            <div>
              <div className="text-xs font-medium text-zinc-400 mb-1">Models</div>
              <ul className="space-y-1">
                {metrics.processes.map((p) => {
                  const pGpu =
                    p.totalSizeBytes > 0
                      ? Math.round((p.vramBytes / p.totalSizeBytes) * 100)
                      : 0;
                  const pCpu = 100 - pGpu;
                  const procLabel =
                    pCpu > 0 && pGpu > 0
                      ? `${pCpu}%/${pGpu}% CPU/GPU`
                      : pGpu > 0
                        ? `${pGpu}% GPU`
                        : "100% CPU";
                  return (
                    <li
                      key={p.name}
                      className="flex items-center justify-between text-xs text-zinc-300"
                    >
                      <span>{p.name}</span>
                      <span className="text-zinc-400">
                        {procLabel} · {formatVram(p.vramBytes)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="text-xs text-zinc-500">No active Ollama models</div>
          )}

          {metrics && metrics.jobs.length > 0 ? (
            <div>
              <div className="text-xs font-medium text-zinc-400 mb-1">Jobs</div>
              <ul className="space-y-1">
                {metrics.jobs.map((job) => (
                  <li
                    key={job.id}
                    className="flex items-center justify-between text-xs text-zinc-300"
                  >
                    <div className="flex flex-col">
                      <span>{job.id}</span>
                      <span className="text-[10px] text-zinc-500">
                        {job.type} · {job.model}
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-label={`Stop ${job.id}`}
                      className="text-[10px] px-2 py-0.5 rounded border border-red-500/60 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                      disabled={!job.canStop || isStopping[job.id] === true}
                      onClick={() => handleStopJob(job.id)}
                    >
                      Stop
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-xs text-zinc-500">No active jobs</div>
          )}
        </div>
      )}
    </div>
  );
}

