/**
 * @fileoverview Hook for fetching and managing thread data.
 * @module hooks/use-threads
 */

import { useEffect, useState } from "preact/hooks";
import { fetchThreads, fetchThread } from "../lib/api-client.js";
import type { Thread, ThreadWithMessages } from "../lib/types.js";

/**
 * @brief Hook for fetching thread list.
 * @param participant - Optional participant ID to filter
 * @returns Threads, loading state, error, and refresh function
 */
export function useThreads(participant?: string) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchThreads(participant);
      setThreads(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [participant]);

  return { threads, loading, error, refresh };
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
