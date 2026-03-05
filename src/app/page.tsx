"use client";

/**
 * @fileoverview App shell: single page that shows one of Chat, Agents, Tasks, Schedule, or Settings
 * by visibility (hidden) so tab content stays mounted and state is preserved when switching tabs.
 * @module app/page
 */

import { use } from "react";
import AppHeader from "@/app/components/AppHeader";
import type { AppViewId } from "@/app/components/AppHeader";
import ChatView from "@/app/views/ChatView";
import AgentsView from "@/app/views/AgentsView";
import TasksView from "@/app/views/TasksView";
import CronView from "@/app/views/CronView";
import SettingsView from "@/app/views/SettingsView";

/** Pre-resolved promise for tests when Next.js does not pass params/searchParams. */
const RESOLVED_EMPTY = Promise.resolve(
  {} as Record<string, string | string[] | undefined>,
);

const VALID_VIEWS: AppViewId[] = [
  "chat",
  "agents",
  "tasks",
  "cron",
  "settings",
];

function parseView(value: string | string[] | undefined): AppViewId {
  const s =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value[0]
        : undefined;
  if (s && (VALID_VIEWS as string[]).includes(s)) return s as AppViewId;
  return "chat";
}

const SUBTITLES: Record<AppViewId, string> = {
  chat: "AI Agent System",
  agents: "Monitor",
  tasks: "Tasks",
  cron: "Schedule",
  settings: "Settings",
};

type HomePageProps = {
  params?: Promise<Record<string, string | undefined>>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * @brief App shell: one header and five view panels; only the active panel is visible so others stay mounted.
 * @param searchParams - Next.js search params; ?view=agents selects the visible tab.
 * @returns Single layout with AppHeader and show/hide panels.
 */
export default function Home(props: HomePageProps = {}) {
  use(
    props.params ??
      (RESOLVED_EMPTY as Promise<Record<string, string | undefined>>),
  );
  const resolved = use(props.searchParams ?? RESOLVED_EMPTY);
  const activeView = parseView(resolved?.view ?? resolved?.["view"]);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <AppHeader activeView={activeView} subtitle={SUBTITLES[activeView]} />

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div
          hidden={activeView !== "chat"}
          className="flex-1 flex flex-col min-h-0 overflow-hidden"
          aria-hidden={activeView !== "chat"}
        >
          <ChatView />
        </div>
        <div
          hidden={activeView !== "agents"}
          className="flex-1 min-h-0 overflow-hidden"
          aria-hidden={activeView !== "agents"}
        >
          <AgentsView />
        </div>
        <div
          hidden={activeView !== "tasks"}
          className="flex-1 min-h-0 overflow-hidden"
          aria-hidden={activeView !== "tasks"}
        >
          <TasksView />
        </div>
        <div
          hidden={activeView !== "cron"}
          className="flex-1 min-h-0 overflow-hidden"
          aria-hidden={activeView !== "cron"}
        >
          <CronView />
        </div>
        <div
          hidden={activeView !== "settings"}
          className="flex-1 min-h-0 overflow-hidden"
          aria-hidden={activeView !== "settings"}
        >
          <SettingsView />
        </div>
      </div>
    </div>
  );
}
