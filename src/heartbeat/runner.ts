/**
 * @fileoverview Heartbeat runner: loads all agent .md files and runs one turn per enabled agent.
 * @module heartbeat/runner
 */

import fs from "node:fs";
import path from "node:path";
import { AGENT_MD_FILES } from "@/agent/context-files";
import { debug } from "@/lib/logger";

export type AgentForHeartbeat = { id: string; enabled: number };

export type RunHeartbeatOnceDeps = {
  sandboxRoot: string;
  listEnabledAgents: () => Promise<AgentForHeartbeat[]>;
  runAgentTurn: (
    agentId: string,
    context: Record<string, string>
  ) => Promise<void>;
};

/**
 * Loads all five .md files for an agent and returns a context object (filename -> content).
 * Missing files get empty string.
 */
export function loadAgentMdContext(
  sandboxRoot: string,
  agentId: string
): Record<string, string> {
  const agentDir = path.join(sandboxRoot, agentId);
  const context: Record<string, string> = {};
  for (const name of AGENT_MD_FILES) {
    const full = path.join(agentDir, name);
    try {
      context[name] = fs.readFileSync(full, "utf-8");
    } catch {
      context[name] = "";
    }
  }
  return context;
}

/**
 * Runs heartbeat for a single agent (used by the timer scheduler when a timer fires).
 * @param deps - Same deps as runHeartbeatOnce
 * @param agentId - Agent to run one heartbeat turn for
 */
export async function runHeartbeatForAgent(
  deps: RunHeartbeatOnceDeps,
  agentId: string
): Promise<void> {
  debug("heartbeat", { event: "agent_turn_start", agentId });
  const context = loadAgentMdContext(deps.sandboxRoot, agentId);
  await deps.runAgentTurn(agentId, context);
  debug("heartbeat", { event: "agent_turn_done", agentId });
}

/**
 * Runs one heartbeat tick: for each enabled agent, loads all .md context and calls runAgentTurn.
 */
export async function runHeartbeatOnce(
  deps: RunHeartbeatOnceDeps
): Promise<void> {
  const agents = await deps.listEnabledAgents();
  const enabled = agents.filter((a) => a.enabled === 1);
  debug("heartbeat", { event: "tick_start", enabledCount: enabled.length, agentIds: enabled.map((a) => a.id) });
  for (const agent of enabled) {
    await runHeartbeatForAgent(deps, agent.id);
  }
  debug("heartbeat", { event: "tick_done" });
}
