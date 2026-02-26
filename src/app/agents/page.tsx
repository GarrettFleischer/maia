"use client";

/**
 * @fileoverview Agents monitor dashboard: agent status, task counts, recent agent activity, cron schedule.
 * @module app/agents/page
 *
 * Replaces the previous simple agents list. Fetches GET /api/dashboard and subscribes to SSE
 * for tasks_changed and agent_status to keep data fresh.
 */

import { use, useCallback, useEffect, useState } from "react";
import type { AgentDefinition, CronJob } from "@/lib/types";
import AppHeader from "@/app/components/AppHeader";

/** Dashboard payload from GET /api/dashboard. */
interface DashboardData {
  agents: AgentDefinition[];
  taskCountsByStatus: { todo: number; in_progress: number; done: number };
  taskCountsByAgent: Record<string, { todo: number; in_progress: number; done: number }>;
  recentAgentSessions: { id: string; name: string; participants: string[]; updatedAt: string }[];
  cronJobs: CronJob[];
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Human-readable cron expression for common patterns.
 * @param expression - Cron expression (e.g. every 30 min style)
 * @returns Short label or the expression itself
 */
function formatCronLabel(expression: string): string {
  if (expression === "*/30 * * * *") return "Every 30 min";
  if (expression === "0 * * * *") return "Hourly";
  if (expression === "0 0 * * *") return "Daily";
  return expression;
}

/** Pre-resolved promise for tests when Next.js does not pass params/searchParams; avoids conditional use() call. */
const RESOLVED_EMPTY = Promise.resolve({} as Record<string, string | string[] | undefined>);

/** Props for agents page; params/searchParams are Promises in Next.js 15 and must be unwrapped with use(). */
type AgentsPageProps = {
  params?: Promise<Record<string, string | undefined>>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default function AgentsPage(props: AgentsPageProps = {}) {
  use(props.params ?? RESOLVED_EMPTY as Promise<Record<string, string | undefined>>);
  use(props.searchParams ?? RESOLVED_EMPTY);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard");
      if (!r.ok) throw new Error(`Dashboard ${r.status}`);
      const d = (await r.json()) as DashboardData;
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("tasks_changed", () => {
      fetchDashboard();
    });
    es.addEventListener("agent_status", () => {
      fetchDashboard();
    });
    return () => es.close();
  }, [fetchDashboard]);

  /** Count agents that are on (not paused/deleted). DB may hold "active", "idle", or "running" from the runner. */
  const activeCount =
    data?.agents.filter((a) => a.status !== "paused" && a.status !== "deleted").length ?? 0;
  const counts = data?.taskCountsByStatus ?? { todo: 0, in_progress: 0, done: 0 };
  const byAgent = data?.taskCountsByAgent ?? {};
  const recentSessions = data?.recentAgentSessions ?? [];
  const cronJobs = data?.cronJobs ?? [];
  const agents = data?.agents ?? [];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader subtitle="Monitor" />

      <main className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold mb-6">Agent monitor</h1>

        {loading && <p className="text-zinc-500 text-sm">Loading...</p>}
        {error && (
          <p className="text-red-400 text-sm mb-4" role="alert">
            {error}
          </p>
        )}

        {!loading && data && (
          <>
            {/* Summary strip */}
            <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8" aria-label="Summary">
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
                <div className="text-xs text-zinc-500 uppercase tracking-wide">Agents</div>
                <div className="text-lg font-semibold mt-0.5">
                  {activeCount} <span className="text-zinc-500 font-normal">/ {agents.length}</span>
                </div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
                <div className="text-xs text-zinc-500 uppercase tracking-wide">To do</div>
                <div className="text-lg font-semibold mt-0.5">{counts.todo}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
                <div className="text-xs text-zinc-500 uppercase tracking-wide">In progress</div>
                <div className="text-lg font-semibold mt-0.5">{counts.in_progress}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
                <div className="text-xs text-zinc-500 uppercase tracking-wide">Done</div>
                <div className="text-lg font-semibold mt-0.5">{counts.done}</div>
              </div>
            </section>

            {/* Agent cards */}
            <section className="mb-8" aria-label="Agent status">
              <h2 className="text-sm font-medium text-zinc-400 mb-3">Agents</h2>
              {agents.length === 0 ? (
                <p className="text-zinc-500 text-sm">No agents yet. Maia will create agents as needed.</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {agents.map((agent) => {
                    const taskCounts = byAgent[agent.id] ?? { todo: 0, in_progress: 0, done: 0 };
                    const taskSummary = [
                      taskCounts.todo > 0 && `${taskCounts.todo} to do`,
                      taskCounts.in_progress > 0 && `${taskCounts.in_progress} in progress`,
                      taskCounts.done > 0 && `${taskCounts.done} done`,
                    ]
                      .filter(Boolean)
                      .join(", ") || "No tasks";
                    return (
                      <div
                        key={agent.id}
                        className="bg-zinc-900 border border-zinc-800 rounded-xl px-5 py-4"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-8 h-8 rounded-full bg-violet-700 flex items-center justify-center text-sm font-bold shrink-0">
                              {agent.name[0]}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium text-sm truncate">{agent.name}</span>
                                {agent.id === "maia" && (
                                  <span className="text-xs bg-violet-900 text-violet-300 px-2 py-0.5 rounded-full shrink-0">
                                    orchestrator
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-zinc-500 truncate">{agent.model}</div>
                            </div>
                          </div>
                          <div
                            className={`text-xs px-2 py-1 rounded-full shrink-0 ${
                              agent.status === "active"
                                ? "bg-green-900/50 text-green-400"
                                : agent.status === "paused"
                                  ? "bg-yellow-900/50 text-yellow-400"
                                  : "bg-zinc-800 text-zinc-500"
                            }`}
                          >
                            {agent.status}
                          </div>
                        </div>
                        <div className="text-xs text-zinc-500 mt-2 ml-10">{taskSummary}</div>
                        <a
                          href="/settings"
                          className="text-xs text-violet-400 hover:text-violet-300 mt-2 ml-10 inline-block"
                        >
                          Settings →
                        </a>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Recent agent activity */}
            <section className="mb-8" aria-label="Recent agent activity">
              <h2 className="text-sm font-medium text-zinc-400 mb-3">Recent agent activity</h2>
              {recentSessions.length === 0 ? (
                <p className="text-zinc-500 text-sm">No agent sessions yet.</p>
              ) : (
                <ul className="space-y-2">
                  {recentSessions.map((s) => (
                    <li key={s.id}>
                      <a
                        href="/"
                        className="block bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 hover:bg-zinc-800/50 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">
                            {s.name || s.id.slice(0, 8)}
                          </span>
                          <span className="text-xs text-zinc-500">{timeAgo(s.updatedAt)}</span>
                        </div>
                        <div className="text-xs text-zinc-500 mt-1">
                          {s.participants.join(", ")}
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Cron / schedule */}
            {cronJobs.length > 0 && (
              <section className="mb-8" aria-label="Schedule">
                <h2 className="text-sm font-medium text-zinc-400 mb-3">Schedule</h2>
                <ul className="space-y-2">
                  {cronJobs.map((job) => {
                    const agent = agents.find((a) => a.id === job.agentId);
                    return (
                      <li
                        key={job.id}
                        className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 flex items-center justify-between gap-2 flex-wrap"
                      >
                        <div>
                          <span className="font-medium text-sm">
                            {job.taskDescription}
                            {job.isBuiltIn && (
                              <span className="text-xs text-zinc-500 ml-1">(built-in)</span>
                            )}
                          </span>
                          <div className="text-xs text-zinc-500 mt-0.5">
                            {formatCronLabel(job.expression)} · {agent?.name ?? job.agentId}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
