/**
 * @fileoverview Compact LLM queue monitor widget for the app header.
 * @module app/components/QueueListMonitor
 *
 * @brief Click to expand; matches Ollama metrics UI pattern (button + expandable panel).
 */

"use client";

import { useEffect, useState, useCallback } from "react";

interface QueueJobSnapshot {
  tool: string;
  args: Record<string, unknown>;
  caller?: string;
  priority: number;
}

const ARGS_TRUNCATE_LEN = 40;

/**
 * Serializes args to a string and truncates for display.
 * @param args - Job args object
 * @returns Truncated string for compact display
 */
function truncateArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const str = JSON.stringify(args);
  if (str.length <= ARGS_TRUNCATE_LEN) return str;
  return `${str.slice(0, ARGS_TRUNCATE_LEN)}…`;
}

/**
 * Serializes args to a formatted string for tooltip.
 * @param args - Job args object
 * @returns Pretty-printed JSON for hover display
 */
function fullArgsString(args: Record<string, unknown>): string {
  return JSON.stringify(args, null, 2);
}

function jobLabel(job: QueueJobSnapshot): string {
  const truncated = truncateArgs(job.args);
  return truncated ? `${job.tool}(${truncated})` : job.tool;
}

/**
 * @brief Header widget: click to expand full queue; matches Ollama metrics pattern.
 * @returns Compact React component.
 */
export default function QueueListMonitor() {
  const [jobs, setJobs] = useState<QueueJobSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/queue");
      if (!res.ok) {
        setError("Queue unavailable");
        setJobs([]);
        return;
      }
      const body = (await res.json()) as { jobs: QueueJobSnapshot[] };
      setJobs(body.jobs ?? []);
      setError(null);
    } catch {
      setError("Queue unavailable");
      setJobs([]);
    }
  }, []);

  useEffect(() => {
    void fetchQueue();

    const es = new EventSource("/api/events");
    es.addEventListener("queue_changed", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { jobs: QueueJobSnapshot[] };
        setJobs(data.jobs ?? []);
        setError(null);
      } catch {
        /* ignore malformed */
      }
    });
    return () => es.close();
  }, [fetchQueue]);

  if (error) {
    return (
      <div className="text-[11px] text-red-400 px-2" title={error}>
        Queue unavailable
      </div>
    );
  }

  const current = jobs[0];
  const hasMore = jobs.length > 1;

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        aria-label="Queue"
        className="flex flex-col items-start px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900 text-left"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="text-[11px] font-medium text-zinc-200">Queue</span>
        {jobs.length === 0 ? (
          <span className="text-[10px] text-zinc-500">Queue empty</span>
        ) : (
          <span className="text-[10px] text-zinc-400 truncate max-w-[200px]">
            {jobLabel(current!)}
            {hasMore && (
              <span className="text-zinc-500 ml-1">+{jobs.length - 1}</span>
            )}
          </span>
        )}
      </button>

      {expanded && (
        <div className="absolute left-0 top-full mt-1 z-20 w-[420px] min-w-[320px] rounded-lg border border-zinc-800 bg-zinc-950 shadow-lg p-3 space-y-3">
          {jobs.length > 0 ? (
            <div>
              <div className="text-xs font-medium text-zinc-400 mb-1">
                Queue ({jobs.length})
              </div>
              <ul className="chat-scroll space-y-1 max-h-60 overflow-y-auto">
                {jobs.map((job, i) => (
                  <li
                    key={`${job.tool}-${i}`}
                    className="text-xs text-zinc-300 truncate hover:bg-zinc-800/60 rounded px-2 py-1 -mx-2"
                    title={fullArgsString(job.args)}
                  >
                    {jobLabel(job)}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-xs text-zinc-500">Queue empty</div>
          )}
        </div>
      )}
    </div>
  );
}
