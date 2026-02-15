/**
 * @fileoverview Hook for fetching and managing thread data.
 * @module hooks/use-threads
 *
 * @note When the WebSocket is connected, threads come from initial_state (no GET
 * on load); when disconnected, the hook falls back to GET /api/threads.
 */

import { useCallback, useEffect, useState } from "preact/hooks";
import { fetchThreads, fetchThread } from "../lib/api-client.js";
import {
  getSyncStoreState,
  subscribeSyncStore,
  updateThreads as updateSyncThreads,
} from "../stores/sync-store.js";
import type { Thread, ThreadWithMessages } from "../lib/types.js";

/**
 * @brief Hook for fetching thread list.
 * @param participant - Optional participant ID to filter (when using sync store we filter client-side)
 * @returns Threads, loading state, error, and refresh function
 */
export function useThreads(participant?: string) {
  const [syncState, setSyncState] = useState(getSyncStoreState);
  const [localThreads, setLocalThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return subscribeSyncStore(() => setSyncState(getSyncStoreState()));
  }, []);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchThreads(participant);
      setLocalThreads(data);
      if (!participant) {
        updateSyncThreads(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [participant]);

  useEffect(() => {
    if (!syncState.wsConnected && !syncState.initialStateReceived) {
      refresh();
    }
  }, [syncState.wsConnected, syncState.initialStateReceived, refresh]);

  const filterByParticipant = (list: Thread[]) =>
    participant ? list.filter((t) => t.participants.includes(participant)) : list;

  if (syncState.wsConnected && !syncState.initialStateReceived) {
    return { threads: [], loading: true, error: null, refresh };
  }
  if (syncState.initialStateReceived) {
    return {
      threads: filterByParticipant(syncState.threads),
      loading: false,
      error: null,
      refresh,
    };
  }
  return { threads: localThreads, loading, error, refresh };
}

/**
 * @brief Hook for fetching a single thread with messages.
 * @param id - Thread identifier
 * @returns Thread with messages, loading state, error, and refresh function
 */
export function useThread(id: string) {
  const [thread, setThread] = useState<ThreadWithMessages | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchThread(id);
      setThread(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [id]);

  return { thread, setThread, loading, error, refresh };
}
