/**
 * @fileoverview Sidebar: list agents, conversations per agent, and Logout.
 * @module app/components/Sidebar
 */

"use client";

import { useAuth } from "./AuthGuard";
import { useEffect, useRef, useState } from "react";

/** Agent id for the built-in Maia assistant (must match server constant). */
const MAIA_AGENT_ID = "maia";

type Agent = { id: string; name: string; enabled: boolean };
type Conversation = {
  id: string;
  agent_id: string;
  type: string;
  participant_agent_id?: string | null;
};

export type SidebarProps = {
  selectedAgentId: string | null;
  selectedConversationId: string | null;
  /** Current conversation type (e.g. "user_chat", "internal"); used so clicking the agent name from a sub-chat returns to main chat. */
  selectedConversationType: string | null;
  onSelectAgent: (id: string | null) => void;
  /** Called with conversationId and type; pass nulls to clear. Agent is set via onSelectAgent. */
  onSelectConversation: (
    conversationId: string | null,
    conversationType: string | null,
  ) => void;
};

function apiFetch(token: string, path: string) {
  return fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function Sidebar({
  selectedAgentId,
  selectedConversationId,
  selectedConversationType,
  onSelectAgent,
  onSelectConversation,
}: SidebarProps) {
  const { token, logout } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversationsByAgent, setConversationsByAgent] = useState<
    Record<string, Conversation[]>
  >({});
  const [loadingAgentId, setLoadingAgentId] = useState<string | null>(null);
  const initialMaiaSelectDone = useRef(false);

  useEffect(() => {
    apiFetch(token, "/api/agents")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Agent[]) => setAgents(list))
      .catch(() => setAgents([]));
  }, [token]);

  useEffect(() => {
    const load = async () => {
      const out: Record<string, Conversation[]> = {};
      for (const a of agents) {
        const r = await apiFetch(token, `/api/agents/${a.id}/conversations`);
        out[a.id] = r.ok ? await r.json() : [];
      }
      setConversationsByAgent(out);
    };
    load();
  }, [token, agents]);

  useEffect(() => {
    if (initialMaiaSelectDone.current || agents.length === 0) return;
    const maia = agents.find((a) => a.id === MAIA_AGENT_ID);
    if (!maia) return;
    initialMaiaSelectDone.current = true;
    selectAgentAndUserChat(maia.id);
  }, [agents]);

  async function selectAgentAndUserChat(agentId: string) {
    if (
      selectedAgentId === agentId &&
      selectedConversationType === "user_chat"
    )
      return;
    setLoadingAgentId(agentId);
    try {
      const r = await apiFetch(token, `/api/agents/${agentId}/user-chat`);
      if (!r.ok) return;
      const { id } = (await r.json()) as { id: string };
      onSelectAgent(agentId);
      onSelectConversation(id, "user_chat");
    } finally {
      setLoadingAgentId(null);
    }
  }

  return (
    <aside
      style={{
        width: "240px",
        borderRight: "1px solid var(--border)",
        padding: "0.5rem",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--bg-secondary)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
        }}
      >
        <strong style={{ color: "var(--text-primary)" }}>Agents</strong>
        <button
          type="button"
          onClick={logout}
          style={{
            fontSize: "0.75rem",
            color: "var(--accent)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
        >
          Logout
        </button>
      </div>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          flex: 1,
          overflow: "auto",
        }}
      >
        {agents.map((a) => {
          const readOnlyThreads = (conversationsByAgent[a.id] ?? []).filter(
            (c) => c.type !== "user_chat",
          );
          return (
            <li key={a.id} style={{ marginBottom: "0.25rem" }}>
              <button
                type="button"
                onClick={() => selectAgentAndUserChat(a.id)}
                disabled={loadingAgentId === a.id}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "0.25rem",
                  background:
                    selectedAgentId === a.id
                      ? "var(--bg-tertiary)"
                      : "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-primary)",
                }}
              >
                {a.name}
                {!a.enabled && " (disabled)"}
                {loadingAgentId === a.id && " …"}
              </button>
              {selectedAgentId === a.id && readOnlyThreads.length > 0 && (
                <ul
                  style={{
                    listStyle: "none",
                    paddingLeft: "1rem",
                    marginTop: "0.25rem",
                  }}
                >
                  {readOnlyThreads.map((c) => {
                    const label =
                      c.type === "internal"
                        ? "My thoughts (internal)"
                        : c.type === "agent_chat" && c.participant_agent_id
                          ? `With ${agents.find((x) => x.id === c.participant_agent_id)?.name ?? c.participant_agent_id}`
                          : c.type;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => onSelectConversation(c.id, c.type)}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            padding: "0.2rem",
                            fontSize: "0.875rem",
                            background:
                              selectedConversationId === c.id
                                ? "var(--bg-tertiary)"
                                : "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--text-muted)",
                          }}
                        >
                          {label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
