/**
 * @fileoverview WebChat channel adapter. Bridges WebSocket connections from the
 * gateway to the agent runtime via the Channel interface.
 * @module channels/webchat
 *
 * @note WebChat messages arrive via WebSocket and are dispatched through the
 * standard Channel.onMessage pipeline. Responses are sent back through the
 * WebSocket handler.
 */

import type {
  Channel,
  ChannelConfig,
  CryptoProvider,
  InboundMessage,
  InboundMessageHandler,
  Logger,
  OutboundMessage,
} from "../core/types.js";
import type { MessageFormatter } from "../core/types.js";
import { createBaseChannel } from "./base.js";

/**
 * @brief Outbound message queue entry (WebSocket messages awaiting delivery).
 */
interface PendingReply {
  recipientId: string;
  content: string;
}

/**
 * @brief Dependencies for createWebChatChannel.
 */
export interface WebChatChannelDeps {
  logger: Logger;
  crypto: CryptoProvider;
  formatter: MessageFormatter;
  /** Callback to send a message back through the WebSocket */
  sendToWS?: (recipientId: string, data: string) => void;
}

/**
 * @brief Creates a WebChat channel adapter.
 * @param deps - Dependencies: logger, crypto, formatter, optional sendToWS
 * @returns Channel implementation for WebChat
 *
 * @example
 * const webchat = createWebChatChannel({
 *   logger, crypto, formatter,
 *   sendToWS: (recipientId, data) => wsHandler.send(recipientId, data),
 * });
 * await webchat.initialize({ enabled: true });
 */
export function createWebChatChannel(deps: WebChatChannelDeps): Channel {
  const { logger, crypto, formatter, sendToWS } = deps;
  const base = createBaseChannel("webchat", "WebChat", { logger });
  let running = false;
  const pendingReplies: PendingReply[] = [];

  return {
    id: base.id,
    name: base.name,

    async initialize(_config: ChannelConfig): Promise<void> {
      running = true;
      logger.info("WebChat channel initialized");
    },

    async shutdown(): Promise<void> {
      running = false;
      pendingReplies.length = 0;
      logger.info("WebChat channel shut down");
    },

    async send(message: OutboundMessage): Promise<void> {
      if (!running) return;

      const formatted = formatter.format(message.content);
      const payload = JSON.stringify({
        type: "chat_response",
        content: formatted,
        replyTo: message.replyTo,
      });

      if (sendToWS) {
        sendToWS(message.recipientId, payload);
      } else {
        pendingReplies.push({
          recipientId: message.recipientId,
          content: payload,
        });
      }

      logger.debug("WebChat message sent", {
        recipientId: message.recipientId,
        length: formatted.length,
      });
    },

    onMessage(handler: InboundMessageHandler): void {
      base.registerHandler(handler);
    },

    /**
     * @brief Injects a WebSocket message into the channel pipeline.
     * @param senderId - WebSocket connection/sender ID
     * @param content - Message content text
     */
    async injectWSMessage(senderId: string, content: string): Promise<void> {
      if (!running) return;

      const message: InboundMessage = {
        id: crypto.randomUUID(),
        channelId: "webchat",
        senderId,
        content,
        timestamp: new Date().toISOString(),
        isGroup: false,
      };

      await base.notifyHandlers(message);
    },
  } as Channel & { injectWSMessage(senderId: string, content: string): Promise<void> };
}
