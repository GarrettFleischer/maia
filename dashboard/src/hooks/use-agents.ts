/**
 * @fileoverview Hook for fetching and caching agent data.
 * @module hooks/use-agents
 */

import { useEffect, useState } from "preact/hooks";
import { fetchAgents, fetchAgent } from "../lib/api-client.js";
import type { Agent, AgentDetail } from "../lib/types.js";

/**
 * @brief Hook for fetching the list of all agents.
 * @returns Agent list, loading state, and error
 *
 * @example
 * const { agents, loading, error, refresh } = useAgents();
 */
export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAgents();
      setAgents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return { agents, loading, error, refresh };
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

  const refresh = async () => {
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
  };

  useEffect(() => {
    refresh();
  }, [id]);

  return { agent, loading, error, refresh };
}
