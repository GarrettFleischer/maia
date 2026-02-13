/**
 * @fileoverview Channel interface and lifecycle management.
 * @module channels/base
 *
 * @note Defines the base channel adapter contract and provides a factory
 * function for creating channel instances from configuration. Each channel
 * adapter handles platform-specific message sending and receiving.
 */

import type {
  Channel,
  ChannelConfig,
  InboundMessage,
  InboundMessageHandler,
  Logger,
  OutboundMessage,
} from "../core/types.js";

/**
 * @brief Base class-like factory deps for all channel adapters.
 */
export interface BaseChannelDeps {
  logger: Logger;
}

/**
 * @brief Creates a base channel adapter with common lifecycle management.
 * @param id - Unique channel identifier
 * @param name - Human-readable channel name
 * @param deps - Base dependencies (logger)
 * @returns Partial Channel with common functionality; callers must provide
 *   initialize, shutdown, and send implementations.
 *
 * @note This provides the onMessage handler registration. Channel-specific
 * adapters extend this by providing their own initialize/shutdown/send.
 *
 * @example
 * const base = createBaseChannel("discord", "Discord", { logger });
 * // Use base.registerHandler, base.notifyHandlers in your adapter implementation
 */
export function createBaseChannel(
  id: string,
  name: string,
  deps: BaseChannelDeps
): {
  id: string;
  name: string;
  handlers: InboundMessageHandler[];
  registerHandler: (handler: InboundMessageHandler) => void;
  notifyHandlers: (message: InboundMessage) => Promise<void>;
} {
  const { logger } = deps;
  const handlers: InboundMessageHandler[] = [];

  return {
    id,
    name,
    handlers,

    /**
     * @brief Registers an inbound message handler.
     * @param handler - Handler function to call on each inbound message
     */
    registerHandler(handler: InboundMessageHandler): void {
      handlers.push(handler);
      logger.debug("Channel handler registered", { channelId: id });
    },

    /**
     * @brief Notifies all registered handlers of an inbound message.
     * @param message - The inbound message to dispatch
     */
    async notifyHandlers(message: InboundMessage): Promise<void> {
      for (const handler of handlers) {
        try {
          await handler(message);
        } catch (err) {
          logger.error("Channel handler error", {
            channelId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}

/**
 * @brief Creates a no-op channel adapter for disabled channels.
 * @param id - Channel identifier
 * @param name - Channel display name
 * @param deps - Base dependencies
 * @returns Channel that does nothing on initialize/shutdown/send
 */
export function createDisabledChannel(
  id: string,
  name: string,
  deps: BaseChannelDeps
): Channel {
  const { logger } = deps;

  return {
    id,
    name,
    async initialize(_config: ChannelConfig): Promise<void> {
      logger.debug("Channel disabled, skipping initialization", {
        channelId: id,
      });
    },
    async shutdown(): Promise<void> {
      /* no-op */
    },
    async send(_message: OutboundMessage): Promise<void> {
      logger.warn("Attempted to send message on disabled channel", {
        channelId: id,
      });
    },
    onMessage(_handler: InboundMessageHandler): void {
      /* no-op */
    },
  };
}
