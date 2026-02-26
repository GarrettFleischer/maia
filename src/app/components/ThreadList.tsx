/**
 * @fileoverview Sidebar list of all threads grouped by type (user chats and AI conversations).
 * @module app/components/ThreadList
 *
 * @brief Renders thread list in two sections ("Your Chats" and "AI Conversations"), a "New thread"
 * control with agent picker, and calls callbacks when user selects a thread or starts a new one.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { SessionMeta } from "@/lib/types";
import ThreadListItem from "./ThreadListItem";

export interface ThreadListProps {
  /** Currently active session id (used to highlight and avoid refetch on select). */
  activeSessionId: string | null;
  /** Called when user selects a thread. */
  onSelectSession: (sessionId: string) => void;
  /** Called when user starts a new thread with the chosen agent (agent id). */
  onNewThreadWithAgent: (agentId: string) => void;
  /** Optional: refetch trigger (e.g. after sending a message or creating thread) so list order/updated_at stays current. */
  refetchTrigger?: number;
  /** Optional: called after a thread is deleted (e.g. to clear active session if it was the deleted one). */
  onThreadDeleted?: (sessionId: string) => void;
}

/**
 * Fetch all sessions (user and agents) from the API.
 * @returns List of SessionMeta or empty on error
 */
async function fetchSessions(): Promise<SessionMeta[]> {
  const res = await fetch("/api/sessions?type=all");
  if (!res.ok) return [];
  const data = (await res.json()) as { sessions: SessionMeta[] };
  return data.sessions ?? [];
}

/** Agent id → display name from GET /api/agents. */
interface AgentListItem {
  id: string;
  name: string;
}

/**
 * Fetch agents and build id → name map and sorted list (Maia first) for thread labels and picker.
 * @returns Object with name map and list of agents with Maia first
 */
async function fetchAgents(): Promise<{ nameMap: Map<string, string>; list: AgentListItem[] }> {
  const res = await fetch("/api/agents");
  if (!res.ok) return { nameMap: new Map(), list: [] };
  const data = (await res.json()) as { agents: AgentListItem[] };
  const list = data.agents ?? [];
  const nameMap = new Map(list.map((a) => [a.id, a.name]));
  const sorted = [...list].sort((a, b) => (a.id === "maia" ? -1 : b.id === "maia" ? 1 : 0));
  return { nameMap, list: sorted };
}

async function deleteSession(sessionId: string): Promise<boolean> {
  const res = await fetch("/api/sessions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  return res.ok;
}

async function renameSession(sessionId: string, name: string): Promise<boolean> {
  const res = await fetch("/api/sessions", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, name }),
  });
  return res.ok;
}

export default function ThreadList({
  activeSessionId,
  onSelectSession,
  onNewThreadWithAgent,
  refetchTrigger = 0,
  onThreadDeleted,
}: ThreadListProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [agentNameMap, setAgentNameMap] = useState<Map<string, string>>(new Map());
  const [agentList, setAgentList] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewThreadPicker, setShowNewThreadPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [sessionsList, agents] = await Promise.all([fetchSessions(), fetchAgents()]);
    setSessions(sessionsList);
    setAgentNameMap(agents.nameMap);
    setAgentList(agents.list);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!showNewThreadPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowNewThreadPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showNewThreadPicker]);

  useEffect(() => {
    load();
  }, [load, refetchTrigger]);

  const handleDelete = useCallback(
    async (sessionId: string) => {
      const ok = await deleteSession(sessionId);
      if (!ok) return;
      await load();
      onThreadDeleted?.(sessionId);
    },
    [load, onThreadDeleted]
  );

  const handleRename = useCallback(
    async (sessionId: string, name: string) => {
      const ok = await renameSession(sessionId, name);
      if (!ok) return;
      await load();
    },
    [load]
  );

  const userSessions = sessions.filter((s) => s.type === "user");
  const agentSessions = sessions.filter((s) => s.type === "agents");

  const handlePickAgent = useCallback(
    (agentId: string) => {
      setShowNewThreadPicker(false);
      onNewThreadWithAgent(agentId);
    },
    [onNewThreadWithAgent]
  );

  return (
    <aside className="w-72 shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900/50">
      <div className="p-2 border-b border-zinc-800 relative" ref={pickerRef}>
        <button
          type="button"
          onClick={() => setShowNewThreadPicker((open) => !open)}
          aria-expanded={showNewThreadPicker}
          aria-haspopup="listbox"
          aria-label="New thread"
          className="w-full px-3 py-2 rounded-lg text-sm font-medium text-violet-300 hover:bg-violet-600/20 border border-violet-500/30 hover:border-violet-500/50 transition-colors"
        >
          + New thread
        </button>
        {showNewThreadPicker && (
          <div
            role="listbox"
            aria-label="Choose agent to chat with"
            className="absolute left-2 right-2 top-full mt-1 z-10 rounded-lg border border-violet-500/30 bg-zinc-900 shadow-lg py-1 max-h-60 overflow-y-auto"
          >
            {agentList.length === 0 ? (
              <div className="px-3 py-2 text-xs text-zinc-500">No agents</div>
            ) : (
              agentList.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => handlePickAgent(agent.id)}
                  className="w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-violet-600/20 focus:bg-violet-600/20 focus:outline-none"
                >
                  {agent.name}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 chat-scroll">
        {loading ? (
          <div className="text-xs text-zinc-500 py-4 text-center">Loading threads…</div>
        ) : sessions.length === 0 ? (
          <div className="text-xs text-zinc-500 py-4 text-center">No threads yet</div>
        ) : (
          <div className="space-y-4">
            {userSessions.length > 0 && (
              <section aria-label="Your Chats">
                <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500 select-none">
                  Your Chats
                </h2>
                <ul className="space-y-1" role="list">
                  {userSessions.map((session) => (
                    <li key={session.id}>
                      <ThreadListItem
                        session={session}
                        isActive={session.id === activeSessionId}
                        onSelect={() => onSelectSession(session.id)}
                        agentNameMap={agentNameMap}
                        onRename={handleRename}
                        onDelete={handleDelete}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {agentSessions.length > 0 && (
              <section aria-label="AI Conversations">
                <h2 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500 select-none">
                  AI Conversations
                </h2>
                <ul className="space-y-1" role="list">
                  {agentSessions.map((session) => (
                    <li key={session.id}>
                      <ThreadListItem
                        session={session}
                        isActive={session.id === activeSessionId}
                        onSelect={() => onSelectSession(session.id)}
                        agentNameMap={agentNameMap}
                        onRename={handleRename}
                        onDelete={handleDelete}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
