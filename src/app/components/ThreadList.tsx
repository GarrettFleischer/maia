/**
 * @fileoverview Sidebar list of all threads (user and agent); fetches sessions, handles selection and new thread.
 * @module app/components/ThreadList
 *
 * @brief Renders thread list, "New thread" control, and calls callbacks when user selects a thread or starts a new one.
 */

import { useState, useEffect, useCallback } from "react";
import type { SessionMeta } from "@/lib/types";
import ThreadListItem from "./ThreadListItem";

export interface ThreadListProps {
  /** Currently active session id (used to highlight and avoid refetch on select). */
  activeSessionId: string | null;
  /** Called when user selects a thread. */
  onSelectSession: (sessionId: string) => void;
  /** Called when user clicks "New thread". */
  onNewThread: () => void;
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
 * Fetch agents and build id → name map for thread labels.
 * @returns Map of agent id to display name, or empty map on error
 */
async function fetchAgentNameMap(): Promise<Map<string, string>> {
  const res = await fetch("/api/agents");
  if (!res.ok) return new Map();
  const data = (await res.json()) as { agents: AgentListItem[] };
  const list = data.agents ?? [];
  return new Map(list.map((a) => [a.id, a.name]));
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
  onNewThread,
  refetchTrigger = 0,
  onThreadDeleted,
}: ThreadListProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [agentNameMap, setAgentNameMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [list, names] = await Promise.all([fetchSessions(), fetchAgentNameMap()]);
    setSessions(list);
    setAgentNameMap(names);
    setLoading(false);
  }, []);

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

  return (
    <aside className="w-60 shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900/50">
      <div className="p-2 border-b border-zinc-800">
        <button
          type="button"
          onClick={onNewThread}
          className="w-full px-3 py-2 rounded-lg text-sm font-medium text-violet-300 hover:bg-violet-600/20 border border-violet-500/30 hover:border-violet-500/50 transition-colors"
        >
          + New thread
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {loading ? (
          <div className="text-xs text-zinc-500 py-4 text-center">Loading threads…</div>
        ) : sessions.length === 0 ? (
          <div className="text-xs text-zinc-500 py-4 text-center">No threads yet</div>
        ) : (
          <ul className="space-y-1" role="list">
            {sessions.map((session) => (
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
        )}
      </div>
    </aside>
  );
}
