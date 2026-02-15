/**
 * @fileoverview WebSocket client singleton for real-time dashboard updates.
 * @module lib/ws-client
 *
 * @brief Maintains a single WebSocket connection to the Maia backend,
 * handles reconnection, and dispatches incoming push messages to listeners.
 */

import type {
  Agent,
  AgentDm,
  AgentStatusUpdate,
  Thread,
  ThreadUpdate,
  ApprovalRequest,
  StatusReport,
} from "./types.js";

/**
 * @brief Payload sent by the server on connect so the client can avoid GET /api/agents and /api/threads.
 */
export interface InitialStatePayload {
  agents: Agent[];
  threads: Thread[];
}

/**
 * @brief Listener callback types for WebSocket events.
 */
export interface WSListeners {
  onInitialState?: (payload: InitialStatePayload) => void;
  onAgentDm?: (dm: AgentDm) => void;
  onAgentStatusUpdate?: (update: AgentStatusUpdate) => void;
  onThreadUpdate?: (update: ThreadUpdate) => void;
  onApprovalRequest?: (request: ApprovalRequest) => void;
  onStatusReport?: (report: StatusReport) => void;
  onChatResponse?: (data: {
    id?: string;
    content: string;
    remembered?: Record<string, string>;
    /** Human-readable one-liners for tool calls (e.g. "Created agent wally"); shown like "will remember that". */
    toolCallsSummary?: string[];
    responderId?: string;
    securityFlagged?: { reason: string; snippet: string };
    progressReport?: { status: string; summary: string };
  }) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  /** Called when the backend broadcasts that an agent was created (so the dashboard can refetch the agent list). */
  onAgentCreated?: () => void;
}

/** @brief Callback for widget_approved push (agentId of the agent whose widget was approved). */
export type WidgetApprovedListener = (agentId: string) => void;

/**
 * @brief WebSocket client interface.
 */
export interface WSClient {
  connect(): void;
  disconnect(): void;
  sendChat(content: string, id?: string): void;
  sendThreadMessage(threadId: string, content: string): void;
  subscribeThread(threadId: string): void;
  unsubscribeThread(threadId: string): void;
  sendApprovalResponse(payload: {
    kind: string;
    decision: string;
    feedback?: string;
    proposalId?: string;
    agentId?: string;
    approvalRequestId?: string;
    requestId?: string;
  }): void;
  isConnected(): boolean;
  setListeners(listeners: WSListeners): void;
  /** Subscribe to widget_approved pushes (e.g. to refetch agent dashboard when a widget is approved). */
  addWidgetApprovedListener(cb: WidgetApprovedListener): void;
  /** Unsubscribe a previously added widget_approved listener. */
  removeWidgetApprovedListener(cb: WidgetApprovedListener): void;
}

/**
 * @brief Creates a WebSocket client for the dashboard.
 * @returns WSClient instance
 *
 * @example
 * const ws = createWSClient();
 * ws.setListeners({
 *   onAgentDm: (dm) => showNotification(dm),
 *   onConnected: () => console.log("Connected!"),
 * });
 * ws.connect();
 */
export function createWSClient(): WSClient {
  let socket: WebSocket | null = null;
  let listeners: WSListeners = {};
  const widgetApprovedListeners = new Set<WidgetApprovedListener>();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1000;
  let connected = false;
  let intentionalClose = false;

  function getWSUrl(): string {
    const token = localStorage.getItem("maia_token") ?? "";
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    return `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`;
  }

  function handleMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data as string) as Record<string, unknown>;
      const type = data.type as string;

      switch (type) {
        case "initial_state": {
          const agents = Array.isArray(data.agents) ? data.agents : [];
          const threads = Array.isArray(data.threads) ? data.threads : [];
          listeners.onInitialState?.({ agents, threads });
          break;
        }
        case "agent_dm":
          listeners.onAgentDm?.(data as unknown as AgentDm);
          break;
        case "agent_status_update":
          listeners.onAgentStatusUpdate?.(data as unknown as AgentStatusUpdate);
          break;
        case "thread_update":
          listeners.onThreadUpdate?.(data as unknown as ThreadUpdate);
          break;
        case "approval_request":
          listeners.onApprovalRequest?.(data as unknown as ApprovalRequest);
          break;
        case "status_report":
          listeners.onStatusReport?.(data as unknown as StatusReport);
          break;
        case "chat_response":
          listeners.onChatResponse?.(data as unknown as {
            id?: string;
            content: string;
            remembered?: Record<string, string>;
            responderId?: string;
            securityFlagged?: { reason: string; snippet: string };
            progressReport?: { status: string; summary: string };
          });
          break;
        case "pong":
          break;
        case "agent_created":
          listeners.onAgentCreated?.();
          break;
        case "widget_approved": {
          const agentId = data.agentId as string | undefined;
          if (typeof agentId === "string") {
            for (const cb of widgetApprovedListeners) {
              try {
                cb(agentId);
              } catch {
                // Ignore listener errors
              }
            }
          }
          break;
        }
        default:
          break;
      }
    } catch {
      // Ignore parse errors
    }
  }

  function scheduleReconnect(): void {
    if (intentionalClose) return;
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);

    // Exponential backoff up to 30s
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function connect(): void {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      return;
    }

    intentionalClose = false;

    try {
      socket = new WebSocket(getWSUrl());

      socket.onopen = () => {
        connected = true;
        reconnectDelay = 1000;
        listeners.onConnected?.();
      };

      socket.onmessage = handleMessage;

      socket.onclose = () => {
        connected = false;
        listeners.onDisconnected?.();
        scheduleReconnect();
      };

      socket.onerror = () => {
        connected = false;
      };
    } catch {
      scheduleReconnect();
    }
  }

  function send(data: Record<string, unknown>): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  // Heartbeat ping every 30s
  setInterval(() => {
    if (connected) {
      send({ type: "ping" });
    }
  }, 30000);

  return {
    connect,

    disconnect(): void {
      intentionalClose = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.close();
        socket = null;
      }
      connected = false;
    },

    sendChat(content: string, id?: string): void {
      send({ type: "chat", content, id });
    },

    sendThreadMessage(threadId: string, content: string): void {
      send({ type: "thread_message", threadId, content });
    },

    subscribeThread(threadId: string): void {
      send({ type: "subscribe_thread", threadId });
    },

    unsubscribeThread(threadId: string): void {
      send({ type: "unsubscribe_thread", threadId });
    },

    sendApprovalResponse(payload: {
      kind: string;
      decision: string;
      feedback?: string;
      proposalId?: string;
      agentId?: string;
      approvalRequestId?: string;
    }): void {
      send({ type: "approval_response", ...payload });
    },

    isConnected(): boolean {
      return connected;
    },

    setListeners(newListeners: WSListeners): void {
      listeners = newListeners;
    },

    addWidgetApprovedListener(cb: WidgetApprovedListener): void {
      widgetApprovedListeners.add(cb);
    },

    removeWidgetApprovedListener(cb: WidgetApprovedListener): void {
      widgetApprovedListeners.delete(cb);
    },
  };
}

/** @brief Global singleton WebSocket client. */
export const wsClient = createWSClient();
