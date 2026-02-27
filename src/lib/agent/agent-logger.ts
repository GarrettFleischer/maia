/**
 * @fileoverview Agent-scoped logging with ANSI colors. Logs emitted during an agent run
 * are prefixed with the agent name in a deterministic color derived from the agent ID.
 * @module lib/agent/agent-logger
 *
 * @example
 * // In runner: wrap the agent loop with runWithAgentContext
 * await runWithAgentContext(agent, async () => {
 *   agentDebug("Processing...");
 * });
 */

import { AsyncLocalStorage } from "async_hooks";

/** Agent identity used for log context. */
export interface AgentLogContext {
  id: string;
  name: string;
}

const agentStorage = new AsyncLocalStorage<AgentLogContext>();

/** ANSI color codes for terminal output. Each agent gets a deterministic color. */
const ANSI_COLORS = [
  32, // green
  36, // cyan
  35, // magenta
  33, // yellow
  34, // blue
  31, // red
  90, // bright black (gray)
  94, // bright blue
  95, // bright magenta
  96, // bright cyan
  92, // bright green
  93, // bright yellow
];

/**
 * Returns an ANSI color code for the given agent ID. Same ID always maps to same color.
 * @param agentId - Agent identifier
 * @returns ANSI color code (e.g. 32 for green)
 */
function colorFromAgentId(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash << 5) - hash + agentId.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % ANSI_COLORS.length;
  return ANSI_COLORS[idx];
}

/**
 * Returns the colored prefix for the current agent context, or empty string if none.
 * @returns Colored "[AgentName] " or ""
 */
function getAgentPrefix(): string {
  const agent = agentStorage.getStore();
  if (!agent) return "";
  const color = colorFromAgentId(agent.id);
  return `\x1b[${color}m[${agent.name}]\x1b[0m `;
}

/**
 * Runs the given async function with the agent context set. All agentDebug/agentError/agentInfo
 * calls within the function (and any async work they trigger) will use this agent for coloring.
 * @param agent - Agent identity for log context
 * @param fn - Async function to run
 * @returns The result of fn
 */
export async function runWithAgentContext<T>(
  agent: AgentLogContext,
  fn: () => Promise<T>,
): Promise<T> {
  return agentStorage.run(agent, fn);
}

/**
 * Logs at debug level with agent-colored prefix when in agent context.
 * @param args - Same as console.debug
 */
export function agentDebug(...args: unknown[]): void {
  const prefix = getAgentPrefix();
  if (prefix && args.length > 0) {
    console.debug(prefix + String(args[0]), ...args.slice(1));
  } else if (prefix) {
    console.debug(prefix);
  } else {
    console.debug(...args);
  }
}

/**
 * Logs at error level with agent-colored prefix when in agent context.
 * @param args - Same as console.error
 */
export function agentError(...args: unknown[]): void {
  const prefix = getAgentPrefix();
  if (prefix && args.length > 0) {
    console.error(prefix + String(args[0]), ...args.slice(1));
  } else if (prefix) {
    console.error(prefix);
  } else {
    console.error(...args);
  }
}

/**
 * Logs at info level with agent-colored prefix when in agent context.
 * @param args - Same as console.info
 */
export function agentInfo(...args: unknown[]): void {
  const prefix = getAgentPrefix();
  if (prefix && args.length > 0) {
    console.info(prefix + String(args[0]), ...args.slice(1));
  } else if (prefix) {
    console.info(prefix);
  } else {
    console.info(...args);
  }
}
