/**
 * @fileoverview Store for dashboard state received over WebSocket on connect.
 * @module stores/sync-store
 *
 * @brief Holds agents and threads sent in initial_state so the client can
 * avoid GET /api/agents and GET /api/threads on load; it then reacts to
 * incremental WS pushes (agent_created, agent_status_update, thread_update).
 */

import type { Agent, Thread } from "../lib/types.js";

export interface SyncStoreState {
  /** Agents list from initial_state or from REST refresh; empty until received. */
  agents: Agent[];
  /** Threads list from initial_state or from REST refresh; empty until received. */
  threads: Thread[];
  /** True after the first initial_state message for this session. */
  initialStateReceived: boolean;
  /** True while the WebSocket is connected (so UI can wait for initial_state instead of fetching). */
  wsConnected: boolean;
}

type Listener = () => void;

let state: SyncStoreState = {
  agents: [],
  threads: [],
  initialStateReceived: false,
  wsConnected: false,
};

const listeners = new Set<Listener>();

/**
 * @brief Returns the current sync store state.
 */
export function getSyncStoreState(): SyncStoreState {
  return state;
}

function setState(updater: (prev: SyncStoreState) => SyncStoreState): void {
  state = updater(state);
  listeners.forEach((l) => l());
}

/**
 * @brief Subscribes to store changes. Call the returned function to unsubscribe.
 * @param listener - Callback invoked when state changes
 * @returns Unsubscribe function
 */
export function subscribeSyncStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * @brief Updates the store with initial state from the WebSocket (agents + threads).
 * Called when the server sends initial_state on connect.
 * @param agents - Full agents list with isRunning
 * @param threads - Full threads list
 */
export function setInitialState(agents: Agent[], threads: Thread[]): void {
  setState((prev) => ({
    ...prev,
    agents,
    threads,
    initialStateReceived: true,
  }));
}

/**
 * @brief Sets WebSocket connection status (called from useWebSocket on connect/disconnect).
 */
export function setWsConnected(connected: boolean): void {
  setState((prev) => ({ ...prev, wsConnected: connected }));
}

/**
 * @brief Updates only the agents list (e.g. after a manual refresh or agent_created refetch).
 * Leaves threads and initialStateReceived unchanged.
 */
export function updateAgents(agents: Agent[]): void {
  setState((prev) => ({ ...prev, agents }));
}

/**
 * @brief Updates only the threads list (e.g. after a manual refresh).
 * Leaves agents and initialStateReceived unchanged.
 */
export function updateThreads(threads: Thread[]): void {
  setState((prev) => ({ ...prev, threads }));
}

/**
 * @brief Clears initial state (e.g. when WebSocket disconnects so client refetches via REST).
 */
export function clearInitialState(): void {
  setState(() => ({
    agents: [],
    threads: [],
    initialStateReceived: false,
    wsConnected: false,
  }));
}
