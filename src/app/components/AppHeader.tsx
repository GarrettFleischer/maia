/**
 * @fileoverview Shared app header with logo, title, nav links, and Ollama performance monitor.
 * @module app/components/AppHeader
 *
 * @brief Renders the Maia header used on Home, Settings, and Agents pages.
 * @param subtitle - Optional subtitle shown under "Maia" (e.g. "AI Agent System", "Settings", "Agents").
 */

import OllamaPerformanceMonitor from "./OllamaPerformanceMonitor";
import QueueListMonitor from "./QueueListMonitor";
export interface AppHeaderProps {
  /** Subtitle under "Maia" (e.g. "AI Agent System", "Settings", "Agents"). */
  subtitle?: string;
}

export default function AppHeader({ subtitle }: AppHeaderProps) {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
      <div className="flex items-center gap-3">
        <a href="/" className="w-8 h-8 rounded-full bg-violet-600 flex items-center justify-center text-sm font-bold">
          M
        </a>
        <div>
          <div className="font-semibold text-sm">Maia</div>
          {subtitle && <div className="text-xs text-zinc-500">{subtitle}</div>}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <nav className="flex gap-4 text-sm text-zinc-400">
          <a href="/" className="hover:text-zinc-100 transition-colors">
            Chat
          </a>
          <a href="/agents" className="hover:text-zinc-100 transition-colors">
            Agents
          </a>
          <a href="/tasks" className="hover:text-zinc-100 transition-colors">
            Tasks
          </a>
          <a href="/cron" className="hover:text-zinc-100 transition-colors">
            Schedule
          </a>
          <a href="/settings" className="hover:text-zinc-100 transition-colors">
            Settings
          </a>
        </nav>
        <QueueListMonitor />
        <OllamaPerformanceMonitor />
      </div>
    </header>
  );
}
