/**
 * @fileoverview Hook for managing WebSocket connection and receiving push events.
 * @module hooks/use-websocket
 *
 * @note Sets all WS listeners in one place (including onChatResponse that updates
 * the chat store) so Chat does not overwrite listeners when it mounts.
 */

import { useEffect, useState } from "preact/hooks";
import { wsClient } from "../lib/ws-client.js";
import { addChatMessage, setChatLoading } from "../stores/chat-store.js";
import {
  setInitialState,
  setWsConnected,
  clearInitialState,
} from "../stores/sync-store.js";
import type {
  AgentDm,
  AgentStatusUpdate,
  ApprovalRequest,
  StatusReport,
} from "../lib/types.js";

/**
 * @brief Options for useWebSocket (e.g. callback when an agent is created).
 */
export interface UseWebSocketOptions {
  /** Called when the backend sends agent_created so the dashboard can refetch the agent list. */
  onAgentCreated?: () => void;
}

/**
 * @brief Hook that manages the WebSocket connection lifecycle.
 * Connects on mount, disconnects on unmount, and provides
 * connection status + recent push events.
 *
 * @param options - Optional callbacks (e.g. onAgentCreated to refetch agents)
 * @returns WebSocket state object
 *
 * @example
 * const { connected, notifications, agentStatuses, approvalRequest, sendApprovalResponse } = useWebSocket();
 * const { refresh } = useAgents();
 * useWebSocket({ onAgentCreated: refresh });
 */
export function useWebSocket(options?: UseWebSocketOptions) {
  const [connected, setConnected] = useState(false);
  const [notifications, setNotifications] = useState<AgentDm[]>([]);
  const [agentStatuses, setAgentStatuses] = useState<Map<string, AgentStatusUpdate>>(new Map());
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const [statusReports, setStatusReports] = useState<StatusReport[]>([]);

  const onAgentCreated = options?.onAgentCreated;

  useEffect(() => {
    wsClient.setListeners({
      onConnected: () => {
        setConnected(true);
        setWsConnected(true);
      },
      onDisconnected: () => {
        setConnected(false);
        clearInitialState();
      },
      onInitialState: (payload) => setInitialState(payload.agents, payload.threads),
      onAgentCreated,
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
      onChatResponse: (data) => {
        addChatMessage({
          id: data.id ?? crypto.randomUUID(),
          content: data.content,
          senderType: "maia",
          createdAt: new Date().toISOString(),
          ...(data.remembered && Object.keys(data.remembered).length > 0
            ? { remembered: data.remembered, responderId: data.responderId }
            : {}),
          ...(data.toolCallsSummary && data.toolCallsSummary.length > 0
            ? { toolCallsSummary: data.toolCallsSummary }
            : {}),
        });
        setChatLoading(false);
      },
    });

    wsClient.connect();

    // Do not disconnect on cleanup: remounts (e.g. router, Strict Mode) would
    // otherwise close the socket and the UI would show "Disconnected". Only
    // disconnect on explicit logout (see App logout handler).
    return () => {};
  }, [onAgentCreated]);

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
