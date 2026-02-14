/**
 * @fileoverview Dashboard home page showing recent activity and DMs.
 * @module routes/Home
 */

import { useEffect, useState } from "preact/hooks";
import { route } from "preact-router";
import { fetchHealth } from "../lib/api-client.js";
import type { Agent, AgentDm, AgentStatusUpdate } from "../lib/types.js";

interface HomeProps {
  path?: string;
  agents: Agent[];
  notifications: AgentDm[];
  agentStatuses: Map<string, AgentStatusUpdate>;
}

/**
 * @brief Dashboard home page with system status, recent notifications, and agent overview.
 */
export function Home({ agents, notifications, agentStatuses }: HomeProps) {
  const [health, setHealth] = useState<{ ok: boolean; uptime: number; version: string } | null>(null);

  useEffect(() => {
    fetchHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <div class="p-6 max-w-5xl">
      <h1 class="text-2xl font-semibold text-maia-text mb-6">Dashboard</h1>

      {/* Status cards */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div class="bg-maia-surface border border-maia-border rounded-xl p-4">
          <p class="text-xs text-maia-text-dim uppercase tracking-wider mb-1">System</p>
          <p class="text-lg font-medium text-maia-text">
            {health ? (health.ok ? "Online" : "Error") : "Loading..."}
          </p>
          {health && (
            <p class="text-xs text-maia-text-dim mt-1">
              Uptime: {formatUptime(health.uptime)} • v{health.version}
            </p>
          )}
        </div>

        <div class="bg-maia-surface border border-maia-border rounded-xl p-4">
          <p class="text-xs text-maia-text-dim uppercase tracking-wider mb-1">Active Agents</p>
          <p class="text-lg font-medium text-maia-text">
            {agents.filter((a) => a.isRunning).length}
            <span class="text-sm text-maia-text-dim"> / {agents.length}</span>
          </p>
        </div>

        <div class="bg-maia-surface border border-maia-border rounded-xl p-4">
          <p class="text-xs text-maia-text-dim uppercase tracking-wider mb-1">Notifications</p>
          <p class="text-lg font-medium text-maia-text">{notifications.length}</p>
        </div>
      </div>

      {/* Recent DMs */}
      <div class="mb-8">
        <h2 class="text-lg font-medium text-maia-text mb-3">Recent Messages</h2>
        {notifications.length === 0 ? (
          <p class="text-sm text-maia-text-dim bg-maia-surface border border-maia-border rounded-xl p-4">
            No recent messages. Maia and your agents will appear here when they have updates.
          </p>
        ) : (
          <div class="space-y-2">
            {notifications.slice(-5).reverse().map((dm, i) => (
              <div
                key={i}
                class="bg-maia-surface border border-maia-border rounded-xl p-3 cursor-pointer
                       hover:bg-maia-surface-light transition-colors"
                onClick={() => route(`/threads/${dm.threadId}`)}
              >
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-sm font-medium text-maia-accent">
                    {dm.agentId === "maia" ? "🌙" : "🤖"} {dm.agentName}
                  </span>
                </div>
                <p class="text-sm text-maia-text line-clamp-2">{dm.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Agent Overview */}
      <div>
        <h2 class="text-lg font-medium text-maia-text mb-3">Agent Activity</h2>
        {agents.length === 0 ? (
          <p class="text-sm text-maia-text-dim bg-maia-surface border border-maia-border rounded-xl p-4">
            No agents registered yet. Maia can create agents or you can ask her to.
          </p>
        ) : (
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            {agents.map((agent) => {
              const status = agentStatuses.get(agent.id);
              return (
                <div
                  key={agent.id}
                  class="bg-maia-surface border border-maia-border rounded-xl p-4 cursor-pointer
                         hover:bg-maia-surface-light transition-colors"
                  onClick={() => route(`/agents/${agent.id}`)}
                >
                  <div class="flex items-center gap-2 mb-2">
                    <span>{agent.emoji}</span>
                    <span class="font-medium text-maia-text">{agent.name}</span>
                    <span class={`w-2 h-2 rounded-full ${agent.isRunning ? "bg-maia-success" : "bg-maia-text-dim"}`} />
                  </div>
                  {status ? (
                    <p class="text-xs text-maia-text-dim line-clamp-2">{status.summary}</p>
                  ) : (
                    <p class="text-xs text-maia-text-dim">{agent.personality.slice(0, 100)}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
