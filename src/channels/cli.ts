/**
 * @fileoverview Interactive CLI channel adapter.
 * @module channels/cli
 *
 * @note Provides a REPL-style interface for local chat. Reads from stdin
 * and writes to stdout. Supports special commands like /quit, /private,
 * and /history.
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
 * @brief Dependencies for createCLIChannel.
 */
export interface CLIChannelDeps {
  logger: Logger;
  crypto: CryptoProvider;
  formatter: MessageFormatter;
  /** Process stdin reader — injected for testability */
  readLine?: () => Promise<string | null>;
  /** Process stdout writer — injected for testability */
  writeLine?: (line: string) => void;
}

/**
 * @brief Creates a CLI channel adapter for interactive local chat.
 * @param deps - Dependencies: logger, crypto, formatter, optional IO overrides
 * @returns Channel implementation for CLI
 *
 * @note When no readLine/writeLine are provided, the channel is intended
 * to be driven externally (e.g., by the main entry point that handles stdin).
 *
 * @example
 * const cli = createCLIChannel({ logger, crypto, formatter });
 * await cli.initialize({ enabled: true });
 * cli.onMessage(async (msg) => {
 *   // Process message through agent runtime
 * });
 */
export function createCLIChannel(deps: CLIChannelDeps): Channel {
  const { logger, crypto, formatter, writeLine } = deps;
  const base = createBaseChannel("cli", "CLI", { logger });
  let running = false;

  return {
    id: base.id,
    name: base.name,

    async initialize(_config: ChannelConfig): Promise<void> {
      running = true;
      logger.info("CLI channel initialized");
      if (writeLine) {
        writeLine("Maia CLI ready. Type /quit to exit, /private to toggle privacy mode.");
      }
    },

    async shutdown(): Promise<void> {
      running = false;
      logger.info("CLI channel shut down");
    },

    async send(message: OutboundMessage): Promise<void> {
      if (!running) return;
      const formatted = formatter.format(message.content);
      if (writeLine) {
        writeLine(formatted);
      }
      logger.debug("CLI message sent", { length: formatted.length });
    },

    onMessage(handler: InboundMessageHandler): void {
      base.registerHandler(handler);
    },

    /**
     * @brief Injects a user input line into the channel (used by the main loop).
     * @param input - Raw user input string
     * @note This is not part of the Channel interface but is exposed for
     * the main entry point to call when it reads a line from stdin.
     */
    async injectInput(input: string): Promise<void> {
      if (!running) return;

      const message: InboundMessage = {
        id: crypto.randomUUID(),
        channelId: "cli",
        senderId: "local-user",
        content: input,
        timestamp: new Date().toISOString(),
        isGroup: false,
      };

      await base.notifyHandlers(message);
    },
  } as Channel & { injectInput(input: string): Promise<void> };
}
