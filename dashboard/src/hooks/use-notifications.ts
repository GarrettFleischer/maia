/**
 * @fileoverview Hook for managing agent DM notifications.
 * @module hooks/use-notifications
 */

import { useState, useCallback } from "preact/hooks";
import type { AgentDm } from "../lib/types.js";

/**
 * @brief Hook for managing a queue of DM notifications.
 * @returns Notification state and handlers
 *
 * @example
 * const { notifications, addNotification, dismissNotification } = useNotifications();
 */
export function useNotifications() {
  const [notifications, setNotifications] = useState<AgentDm[]>([]);

  const addNotification = useCallback((dm: AgentDm) => {
    setNotifications((prev) => [...prev, dm]);

    // Auto-dismiss after 10 seconds
    setTimeout(() => {
      setNotifications((prev) => prev.slice(1));
    }, 10000);
  }, []);

  const dismissNotification = useCallback((index: number) => {
    setNotifications((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  return {
    notifications,
    addNotification,
    dismissNotification,
    clearAll,
  };
}
