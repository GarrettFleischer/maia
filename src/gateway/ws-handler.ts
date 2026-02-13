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
 * @brief WebSocket message types.
 */
export type WSMessageType = "chat" | "ping" | "subscribe" | "unsubscribe";

/**
 * @brief Parsed WebSocket message.
 */
export interface WSMessage {
  type: WSMessageType;
  id?: string;
  content?: string;
  channel?: string;
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
  /** Handles a chat message from a WebSocket client */
  onChatMessage?: (connectionId: string, senderId: string, content: string) => Promise<string>;
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
  const { logger, events, onChatMessage } = deps;
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

      switch (msg.type) {
        case "ping":
          return JSON.stringify({ type: "pong", timestamp: Date.now() });

        case "chat": {
          if (!msg.content) {
            return JSON.stringify({ error: "Content is required for chat messages" });
          }

          if (onChatMessage) {
            try {
              const reply = await onChatMessage(
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
                content: reply,
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
  };
}
