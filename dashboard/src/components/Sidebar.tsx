/**
 * @fileoverview Dashboard sidebar with Maia status, navigation, and agent list.
 * @module components/Sidebar
 */

import { route } from "preact-router";
import type { Agent } from "../lib/types.js";
import { StatusBadge } from "./StatusBadge.js";

interface SidebarProps {
  agents: Agent[];
  connected: boolean;
  currentPath: string;
}

/**
 * @brief Navigation link component.
 */
function NavLink({ href, label, icon, active }: { href: string; label: string; icon: string; active: boolean }) {
  return (
    <button
      onClick={() => route(href)}
      class={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors
        ${active
          ? "bg-maia-accent/20 text-maia-accent"
          : "text-maia-text-dim hover:bg-maia-surface-light hover:text-maia-text"
        }`}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/**
 * @brief Dashboard sidebar component.
 * @param props - agents list, connection status, current route path
 * @returns Preact element
 */
export function Sidebar({ agents, connected, currentPath }: SidebarProps) {
  return (
    <aside class="w-64 h-screen bg-maia-surface border-r border-maia-border flex flex-col overflow-hidden">
      {/* Header */}
      <div class="px-4 py-4 border-b border-maia-border">
        <div class="flex items-center gap-2">
          <span class="text-xl">🌙</span>
          <span class="text-lg font-semibold text-maia-text">Maia</span>
        </div>
        <div class="mt-1 flex items-center gap-1.5">
          <span class={`w-2 h-2 rounded-full ${connected ? "bg-maia-success" : "bg-maia-error"}`} />
          <span class="text-xs text-maia-text-dim">
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav class="px-3 py-3 space-y-1">
        <NavLink href="/" label="Dashboard" icon="📊" active={currentPath === "/"} />
        <NavLink href="/chat" label="Chat with Maia" icon="💬" active={currentPath === "/chat"} />
        <NavLink href="/agents" label="Agents" icon="🤖" active={currentPath.startsWith("/agents")} />
        <NavLink href="/threads" label="Threads" icon="🧵" active={currentPath.startsWith("/threads")} />
      </nav>

      {/* Agent List */}
      <div class="flex-1 overflow-y-auto px-3 py-2 border-t border-maia-border">
        <h3 class="text-xs font-medium text-maia-text-dim uppercase tracking-wider px-3 py-2">
          Agents ({agents.length})
        </h3>
        <div class="space-y-0.5">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => route(`/agents/${agent.id}`)}
              class={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors
                ${currentPath === `/agents/${agent.id}`
                  ? "bg-maia-accent/20 text-maia-accent"
                  : "text-maia-text-dim hover:bg-maia-surface-light hover:text-maia-text"
                }`}
            >
              <span>{agent.emoji}</span>
              <span class="truncate flex-1 text-left">{agent.name}</span>
              <StatusBadge status={agent.isRunning ? "active" : "idle"} size="sm" />
            </button>
          ))}
          {agents.length === 0 && (
            <p class="px-3 py-2 text-xs text-maia-text-dim">No agents yet</p>
          )}
        </div>
      </div>
    </aside>
  );
}
