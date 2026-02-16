/**
 * @fileoverview In-memory store for agent "thinking" monologue entries.
 * @module agents/agent-thoughts
 *
 * @brief Used by the dashboard sidebar to show each agent's internal thoughts.
 * Entries are appended when agents use progress_report (thinking/planning) or share_thought.
 */

/** @brief A single thought entry for one agent. */
export interface AgentThought {
  id: string;
  agentId: string;
  content: string;
  createdAt: string;
}

const MAX_THOUGHTS_PER_AGENT = 100;

/**
 * @brief In-memory store for recent thoughts per agent.
 * @returns Object with push, get, and getAll methods
 */
export function createAgentThoughtsStore() {
  const byAgent = new Map<string, AgentThought[]>();
  let idCounter = 0;

  function nextId(): string {
    idCounter += 1;
    return `thought-${idCounter}-${Date.now()}`;
  }

  return {
    /**
     * @brief Append a thought for an agent. Trims to max size per agent.
     * @param agentId - Agent (or "maia") ID
     * @param content - Thought text
     * @returns The created thought (id, agentId, content, createdAt)
     */
    push(agentId: string, content: string): AgentThought {
      const list = byAgent.get(agentId) ?? [];
      const thought: AgentThought = {
        id: nextId(),
        agentId,
        content,
        createdAt: new Date().toISOString(),
      };
      list.push(thought);
      if (list.length > MAX_THOUGHTS_PER_AGENT) {
        list.splice(0, list.length - MAX_THOUGHTS_PER_AGENT);
      }
      byAgent.set(agentId, list);
      return thought;
    },

    /**
     * @brief Get recent thoughts for an agent (newest last).
     * @param agentId - Agent ID
     * @returns Array of thoughts
     */
    get(agentId: string): AgentThought[] {
      return byAgent.get(agentId) ?? [];
    },

    /**
     * @brief Get all thoughts for all agents (for debugging or bulk API).
     * @returns Map of agentId to thoughts
     */
    getAll(): Map<string, AgentThought[]> {
      const out = new Map<string, AgentThought[]>();
      for (const [id, list] of byAgent) {
        out.set(id, [...list]);
      }
      return out;
    },
  };
}

export type AgentThoughtsStore = ReturnType<typeof createAgentThoughtsStore>;
