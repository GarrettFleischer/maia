/**
 * @fileoverview Shared app header with logo, title, nav tabs, and Ollama performance monitor.
 * @module app/components/AppHeader
 *
 * @brief Renders the Maia header; nav uses client-side view param so tab content stays mounted.
 * @param activeView - Current view id for highlighting the active tab.
 * @param subtitle - Optional subtitle shown under "Maia" (e.g. "AI Agent System", "Settings").
 */

import Link from "next/link";
import OllamaPerformanceMonitor from "./OllamaPerformanceMonitor";
import QueueListMonitor from "./QueueListMonitor";

/** View ids used for URL ?view= and tab highlighting. */
export type AppViewId = "chat" | "agents" | "tasks" | "cron" | "settings";

const VIEW_IDS: AppViewId[] = ["chat", "agents", "tasks", "cron", "settings"];

const VIEW_LABELS: Record<AppViewId, string> = {
  chat: "Chat",
  agents: "Agents",
  tasks: "Tasks",
  cron: "Schedule",
  settings: "Settings",
};

export interface AppHeaderProps {
  /** Current view so the active tab can be highlighted. */
  activeView: AppViewId;
  /** Optional subtitle under "Maia" (e.g. "AI Agent System", "Settings"). */
  subtitle?: string;
}

export default function AppHeader({ activeView, subtitle }: AppHeaderProps) {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="w-8 h-8 rounded-full bg-violet-600 flex items-center justify-center text-sm font-bold"
        >
          M
        </Link>
        <div>
          <div className="font-semibold text-sm">Maia</div>
          {subtitle && <div className="text-xs text-zinc-500">{subtitle}</div>}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <nav className="flex gap-4 text-sm text-zinc-400" aria-label="Main">
          {VIEW_IDS.map((id) => (
            <Link
              key={id}
              href={id === "chat" ? "/" : `/?view=${id}`}
              className={
                activeView === id
                  ? "text-zinc-100 font-medium"
                  : "hover:text-zinc-100 transition-colors"
              }
            >
              {VIEW_LABELS[id]}
            </Link>
          ))}
        </nav>
        <QueueListMonitor />
        <OllamaPerformanceMonitor />
      </div>
    </header>
  );
}
