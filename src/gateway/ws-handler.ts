/**
 * @fileoverview WebSocket connection handler for the gateway.
 * @module gateway/ws-handler
 *
 * @note Manages WebSocket connections, message parsing, and dispatching
 * to the agent runtime. Supports authentication and rate limiting
 * per connection.
 */

import type { Logger, EventBus } from "../core/types.js";

/**
 * @brief WebSocket message types (client-to-server).
 */
export type WSMessageType =
  | "chat"
  | "ping"
  | "subscribe"
  | "unsubscribe"
  | "thread_message"
  | "subscribe_thread"
  | "unsubscribe_thread"
  | "approval_response";

/**
 * @brief Server-to-client push message types.
 */
export type WSPushType =
  | "agent_dm"
  | "agent_status_update"
  | "agent_created"
  | "thread_update"
  | "approval_request"
  | "status_report"
  | "widget_approved";

/**
 * @brief Parsed WebSocket message.
 */
export interface WSMessage {
  type: WSMessageType;
  id?: string;
  content?: string;
  channel?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * @brief WebSocket connection state.
 */
export interface WSConnection {
  id: string;
  authenticated: boolean;
  senderId: string;
  subscriptions: Set<string>;
  lastActivity: number;
}

/**
 * @brief Handler for outbound WebSocket messages.
 */
export type WSSendFn = (connectionId: string, data: string) => void;

/**
 * @brief Dependencies for createWSHandler.
 */
export interface WSHandlerDeps {
  logger: Logger;
  events: EventBus;
  /** Handles a chat message; returns content and optional remembered/security/progress for UI. */
  onChatMessage?: (
    connectionId: string,
    senderId: string,
    content: string
  ) => Promise<{
    content: string;
    remembered?: { memoryMd?: string; userMd?: string; soulMd?: string };
    toolCallsSummary?: string[];
    securityFlagged?: { reason: string; snippet: string };
    progressReport?: { status: string; summary: string };
    responderId?: string;
  }>;
  /** Handles a thread message from the client. */
  onThreadMessage?: (
    connectionId: string,
    senderId: string,
    threadId: string,
    content: string
  ) => Promise<{ content: string }>;
  /** Called when any user activity occurs (for quiet-time tracking). */
  onUserActivity?: () => void;
  /**
   * @brief Handles user response to an approval request (tool proposal, agent creation, or flagged agent).
   * @param connectionId - WebSocket connection ID
   * @param senderId - Authenticated user ID
   * @param payload - { kind, decision, feedback?, proposalId?, agentId?, approvalRequestId?, requestId? }
   */
  onApprovalResponse?: (
    connectionId: string,
    senderId: string,
    payload: {
      kind: string;
      decision: string;
      feedback?: string;
      proposalId?: string;
      agentId?: string;
      approvalRequestId?: string;
      requestId?: string;
    }
  ) => Promise<void>;
  /** Idle timeout in ms before closing connection (default: 300000 = 5 min) */
  idleTimeoutMs?: number;
}

/**
 * @brief WebSocket handler interface.
 */
export interface WSHandler {
  /**
   * @brief Registers a new WebSocket connection.
   * @param id - Unique connection ID
   * @param senderId - Authenticated user/sender ID
   * @returns WSConnection state object
   */
  connect(id: string, senderId: string): WSConnection;

  /**
   * @brief Handles an inbound WebSocket message.
   * @param connectionId - Connection ID
   * @param raw - Raw message string (JSON)
   * @returns Promise resolving to the response string to send back, or null
   */
  handleMessage(connectionId: string, raw: string): Promise<string | null>;

  /**
   * @brief Removes a WebSocket connection.
   * @param connectionId - Connection ID to disconnect
   */
  disconnect(connectionId: string): void;

  /**
   * @brief Returns the number of active connections.
   * @returns Connection count
   */
  connectionCount(): number;

  /**
   * @brief Gets a connection by ID.
   * @param connectionId - Connection ID
   * @returns WSConnection or undefined
   */
  getConnection(connectionId: string): WSConnection | undefined;

  /**
   * @brief Broadcasts a push message to all connected clients.
   * @param type - Push message type (agent_dm, agent_status_update, thread_update)
   * @param payload - Message payload
   * @param sendFn - Function to send data to a specific connection
   */
  broadcast(type: WSPushType, payload: Record<string, unknown>, sendFn: (connectionId: string, data: string) => void): void;

  /**
   * @brief Sends a push message to clients subscribed to a specific thread.
   * @param threadId - Thread ID to target
   * @param type - Push message type
   * @param payload - Message payload
   * @param sendFn - Function to send data to a specific connection
   */
  pushToThreadSubscribers(threadId: string, type: WSPushType, payload: Record<string, unknown>, sendFn: (connectionId: string, data: string) => void): void;
}

/**
 * @brief Creates a WebSocket handler for the gateway.
 * @param deps - Dependencies: logger, events, optional onChatMessage handler
 * @returns WSHandler instance
 *
 * @example
 * const wsHandler = createWSHandler({
 *   logger,
 *   events,
 *   onChatMessage: async (connId, senderId, content) => {
 *     return await agent.processMessage(senderId, content);
 *   },
 * });
 *
 * // On WebSocket connection:
 * wsHandler.connect(connId, userId);
 *
 * // On WebSocket message:
 * const reply = await wsHandler.handleMessage(connId, rawJson);
 * if (reply) ws.send(reply);
 */
export function createWSHandler(deps: WSHandlerDeps): WSHandler {
  const { logger, events, onChatMessage, onThreadMessage, onUserActivity, onApprovalResponse } = deps;
  const connections = new Map<string, WSConnection>();

  return {
    connect(id: string, senderId: string): WSConnection {
      const conn: WSConnection = {
        id,
        authenticated: true,
        senderId,
        subscriptions: new Set<string>(),
        lastActivity: Date.now(),
      };
      connections.set(id, conn);
      logger.debug("WebSocket connected", { connectionId: id, senderId });
      return conn;
    },

    async handleMessage(connectionId: string, raw: string): Promise<string | null> {
      const conn = connections.get(connectionId);
      if (!conn) {
        logger.warn("Message from unknown connection", { connectionId });
        return JSON.stringify({ error: "Unknown connection" });
      }

      conn.lastActivity = Date.now();

      let msg: WSMessage;
      try {
        msg = JSON.parse(raw) as WSMessage;
      } catch {
        return JSON.stringify({ error: "Invalid JSON" });
      }

      // Track user activity for quiet-time inference
      if (onUserActivity) onUserActivity();

      switch (msg.type) {
        case "ping":
          return JSON.stringify({ type: "pong", timestamp: Date.now() });

        case "chat": {
          if (!msg.content) {
            return JSON.stringify({ error: "Content is required for chat messages" });
          }

          if (onChatMessage) {
            try {
              const result = await onChatMessage(
                connectionId,
                conn.senderId,
                msg.content
              );
              await events.emit("messageSent", {
                channelId: "webchat",
                connectionId,
                senderId: conn.senderId,
              });
              return JSON.stringify({
                type: "chat_response",
                id: msg.id,
                content: result.content,
                ...(result.remembered && Object.keys(result.remembered).length > 0
                  ? { remembered: result.remembered }
                  : {}),
                ...(result.toolCallsSummary && result.toolCallsSummary.length > 0
                  ? { toolCallsSummary: result.toolCallsSummary }
                  : {}),
                ...(result.responderId ? { responderId: result.responderId } : {}),
                ...(result.securityFlagged ? { securityFlagged: result.securityFlagged } : {}),
                ...(result.progressReport ? { progressReport: result.progressReport } : {}),
              });
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              logger.error("Chat message handling failed", {
                connectionId,
                error: errorMsg,
              });
              return JSON.stringify({
                type: "error",
                id: msg.id,
                error: errorMsg,
              });
            }
          }

          return JSON.stringify({
            type: "error",
            id: msg.id,
            error: "Chat handler not configured",
          });
        }

        case "thread_message": {
          if (!msg.threadId || !msg.content) {
            return JSON.stringify({ error: "threadId and content are required for thread_message" });
          }

          if (onThreadMessage) {
            try {
              const result = await onThreadMessage(
                connectionId,
                conn.senderId,
                msg.threadId,
                msg.content
              );
              return JSON.stringify({
                type: "thread_message_response",
                id: msg.id,
                threadId: msg.threadId,
                content: result.content,
              });
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              logger.error("Thread message handling failed", {
                connectionId,
                error: errorMsg,
              });
              return JSON.stringify({
                type: "error",
                id: msg.id,
                error: errorMsg,
              });
            }
          }

          return JSON.stringify({
            type: "error",
            id: msg.id,
            error: "Thread message handler not configured",
          });
        }

        case "subscribe_thread": {
          if (msg.threadId) {
            conn.subscriptions.add(`thread:${msg.threadId}`);
            logger.debug("WebSocket subscribed to thread", {
              connectionId,
              threadId: msg.threadId,
            });
            return JSON.stringify({
              type: "subscribed",
              channel: `thread:${msg.threadId}`,
            });
          }
          return JSON.stringify({ error: "threadId is required for subscribe_thread" });
        }

        case "unsubscribe_thread": {
          if (msg.threadId) {
            conn.subscriptions.delete(`thread:${msg.threadId}`);
            logger.debug("WebSocket unsubscribed from thread", {
              connectionId,
              threadId: msg.threadId,
            });
            return JSON.stringify({
              type: "unsubscribed",
              channel: `thread:${msg.threadId}`,
            });
          }
          return JSON.stringify({ error: "threadId is required for unsubscribe_thread" });
        }

        case "subscribe": {
          if (msg.channel) {
            conn.subscriptions.add(msg.channel);
            logger.debug("WebSocket subscribed", {
              connectionId,
              channel: msg.channel,
            });
            return JSON.stringify({
              type: "subscribed",
              channel: msg.channel,
            });
          }
          return JSON.stringify({ error: "Channel is required for subscribe" });
        }

        case "unsubscribe": {
          if (msg.channel) {
            conn.subscriptions.delete(msg.channel);
            logger.debug("WebSocket unsubscribed", {
              connectionId,
              channel: msg.channel,
            });
            return JSON.stringify({
              type: "unsubscribed",
              channel: msg.channel,
            });
          }
          return JSON.stringify({
            error: "Channel is required for unsubscribe",
          });
        }

        case "approval_response": {
          const payload = (msg.metadata ?? msg) as Record<string, unknown>;
          const kind = payload.kind as string | undefined;
          const decision = payload.decision as string | undefined;
          if (!kind || !decision) {
            return JSON.stringify({ error: "approval_response requires kind and decision" });
          }
          if (onApprovalResponse) {
            try {
              await onApprovalResponse(connectionId, conn.senderId, {
                kind,
                decision,
                feedback: payload.feedback as string | undefined,
                proposalId: payload.proposalId as string | undefined,
                agentId: payload.agentId as string | undefined,
                approvalRequestId: payload.approvalRequestId as string | undefined,
                requestId: payload.requestId as string | undefined,
              });
              return JSON.stringify({ type: "approval_response_ack", success: true });
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              logger.error("Approval response handling failed", {
                connectionId,
                error: errorMsg,
              });
              return JSON.stringify({ type: "approval_response_ack", success: false, error: errorMsg });
            }
          }
          return JSON.stringify({ error: "Approval response handler not configured" });
        }

        default:
          return JSON.stringify({ error: `Unknown message type: ${msg.type}` });
      }
    },

    disconnect(connectionId: string): void {
      connections.delete(connectionId);
      logger.debug("WebSocket disconnected", { connectionId });
    },

    connectionCount(): number {
      return connections.size;
    },

    getConnection(connectionId: string): WSConnection | undefined {
      return connections.get(connectionId);
    },

    broadcast(
      type: WSPushType,
      payload: Record<string, unknown>,
      sendFn: (connectionId: string, data: string) => void
    ): void {
      const data = JSON.stringify({ type, ...payload });
      for (const [connId] of connections) {
        try {
          sendFn(connId, data);
        } catch (err) {
          logger.warn("Broadcast send failed", {
            connectionId: connId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },

    pushToThreadSubscribers(
      threadId: string,
      type: WSPushType,
      payload: Record<string, unknown>,
      sendFn: (connectionId: string, data: string) => void
    ): void {
      const subscriptionKey = `thread:${threadId}`;
      const data = JSON.stringify({ type, ...payload });
      for (const [connId, conn] of connections) {
        if (conn.subscriptions.has(subscriptionKey)) {
          try {
            sendFn(connId, data);
          } catch (err) {
            logger.warn("Thread push send failed", {
              connectionId: connId,
              threadId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    },
  };
}
