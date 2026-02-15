/**
 * @fileoverview Hook for fetching and caching agent data.
 * @module hooks/use-agents
 *
 * @note When the WebSocket is connected, agents come from initial_state (no GET
 * on load); when disconnected, the hook falls back to GET /api/agents.
 */

import { useCallback, useEffect, useState } from "preact/hooks";
import { fetchAgents, fetchAgent } from "../lib/api-client.js";
import {
  getSyncStoreState,
  subscribeSyncStore,
  updateAgents as updateSyncAgents,
} from "../stores/sync-store.js";
import type { Agent, AgentDetail } from "../lib/types.js";

/**
 * @brief Hook for fetching the list of all agents.
 * @returns Agent list, loading state, error, and a stable refresh function
 *
 * @note When WS is connected, uses initial_state from the sync store (no GET on load).
 * When WS is disconnected, fetches via REST. refresh() always fetches and updates the store.
 *
 * @example
 * const { agents, loading, error, refresh } = useAgents();
 */
export function useAgents() {
  const [syncState, setSyncState] = useState(getSyncStoreState);
  const [localAgents, setLocalAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return subscribeSyncStore(() => setSyncState(getSyncStoreState()));
  }, []);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAgents();
      setLocalAgents(data);
      updateSyncAgents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!syncState.wsConnected && !syncState.initialStateReceived) {
      refresh();
    }
  }, [syncState.wsConnected, syncState.initialStateReceived, refresh]);

  if (syncState.wsConnected && !syncState.initialStateReceived) {
    return { agents: [], loading: true, error: null, refresh };
  }
  if (syncState.initialStateReceived) {
    return { agents: syncState.agents, loading: false, error: null, refresh };
  }
  return { agents: localAgents, loading, error, refresh };
}

/**
 * @brief Hook for fetching a single agent's detail.
 * @param id - Agent identifier
 * @returns Agent detail, loading state, and error
 *
 * @example
 * const { agent, loading, error, refresh } = useAgentDetail("research-bot");
 */
export function useAgentDetail(id: string) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAgent(id);
      setAgent(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { agent, loading, error, refresh };
}
