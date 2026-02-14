/**
 * @fileoverview Hook for managing WebSocket connection and receiving push events.
 * @module hooks/use-websocket
 */

import { useEffect, useState } from "preact/hooks";
import { wsClient } from "../lib/ws-client.js";
import type {
  AgentDm,
  AgentStatusUpdate,
  ThreadUpdate,
  ApprovalRequest,
  StatusReport,
} from "../lib/types.js";

/**
 * @brief Hook that manages the WebSocket connection lifecycle.
 * Connects on mount, disconnects on unmount, and provides
 * connection status + recent push events.
 *
 * @returns WebSocket state object
 *
 * @example
 * const { connected, notifications, agentStatuses, approvalRequest, sendApprovalResponse } = useWebSocket();
 */
export function useWebSocket() {
  const [connected, setConnected] = useState(false);
  const [notifications, setNotifications] = useState<AgentDm[]>([]);
  const [agentStatuses, setAgentStatuses] = useState<Map<string, AgentStatusUpdate>>(new Map());
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const [statusReports, setStatusReports] = useState<StatusReport[]>([]);

  useEffect(() => {
    wsClient.setListeners({
      onConnected: () => setConnected(true),
      onDisconnected: () => setConnected(false),
      onAgentDm: (dm: AgentDm) => {
        setNotifications((prev) => [...prev, dm]);
      },
      onAgentStatusUpdate: (update: AgentStatusUpdate) => {
        setAgentStatuses((prev) => {
          const next = new Map(prev);
          next.set(update.agentId, update);
          return next;
        });
      },
      onApprovalRequest: (request: ApprovalRequest) => {
        setApprovalRequest(request);
      },
      onStatusReport: (report: StatusReport) => {
        setStatusReports((prev) => [...prev.slice(-9), report]);
      },
    });

    wsClient.connect();

    return () => {
      wsClient.disconnect();
    };
  }, []);

  const dismissNotification = (index: number) => {
    setNotifications((prev) => prev.filter((_, i) => i !== index));
  };

  const sendApprovalResponse = (payload: {
    kind: string;
    decision: string;
    feedback?: string;
    proposalId?: string;
    agentId?: string;
    approvalRequestId?: string;
  }) => {
    wsClient.sendApprovalResponse(payload);
    setApprovalRequest(null);
  };

  return {
    connected,
    notifications,
    agentStatuses,
    approvalRequest,
    statusReports,
    dismissNotification,
    dismissApprovalRequest: () => setApprovalRequest(null),
    sendApprovalResponse,
  };
}
