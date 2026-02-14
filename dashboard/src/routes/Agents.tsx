/**
 * @fileoverview Agent list page.
 * @module routes/Agents
 */

import { route } from "preact-router";
import type { Agent } from "../lib/types.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface AgentsProps {
  path?: string;
  agents: Agent[];
  loading: boolean;
  error: string | null;
}

/**
 * @brief Agent list page showing all registered agents.
 */
export function Agents({ agents, loading, error }: AgentsProps) {
  if (loading) {
    return (
      <div class="p-6">
        <h1 class="text-2xl font-semibold text-maia-text mb-6">Agents</h1>
        <p class="text-maia-text-dim">Loading agents...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div class="p-6">
        <h1 class="text-2xl font-semibold text-maia-text mb-6">Agents</h1>
        <p class="text-maia-error">{error}</p>
      </div>
    );
  }

  return (
    <div class="p-6 max-w-5xl">
      <h1 class="text-2xl font-semibold text-maia-text mb-6">Agents</h1>

      {agents.length === 0 ? (
        <div class="bg-maia-surface border border-maia-border rounded-xl p-8 text-center">
          <p class="text-4xl mb-3">🤖</p>
          <p class="text-maia-text mb-2">No agents yet</p>
          <p class="text-sm text-maia-text-dim">
            Ask Maia to create an agent, or they can be created via the API.
          </p>
        </div>
      ) : (
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => (
            <div
              key={agent.id}
              class="bg-maia-surface border border-maia-border rounded-xl p-4 cursor-pointer
                     hover:bg-maia-surface-light hover:border-maia-accent/30 transition-all"
              onClick={() => route(`/agents/${agent.id}`)}
            >
              <div class="flex items-center gap-3 mb-3">
                <span class="text-2xl">{agent.emoji}</span>
                <div class="flex-1 min-w-0">
                  <p class="font-medium text-maia-text truncate">{agent.name}</p>
                  <p class="text-xs text-maia-text-dim">{agent.id}</p>
                </div>
                <StatusBadge status={agent.isRunning ? "active" : "idle"} />
              </div>
              <p class="text-sm text-maia-text-dim line-clamp-2 mb-3">
                {agent.personality}
              </p>
              <div class="flex items-center gap-3 text-xs text-maia-text-dim">
                <span>🧰 {agent.tools.length} tools</span>
                {agent.schedule && <span>📅 {agent.schedule}</span>}
                <span>🧠 {agent.model.provider}/{agent.model.model}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
