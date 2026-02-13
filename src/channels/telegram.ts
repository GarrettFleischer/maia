/**
 * @fileoverview Telegram bot channel adapter.
 * @module channels/telegram
 *
 * @note Connects to Telegram using a bot token stored in the credential store.
 * Supports receiving messages via webhook or long-polling and sending replies
 * via the Telegram Bot API.
 *
 * @note This is a structural implementation using the HttpClient abstraction
 * for testability. Full Telegram Bot API integration (webhooks, inline keyboards)
 * would be added as a production enhancement.
 */

import type {
  Channel,
  ChannelConfig,
  CredentialStore,
  HttpClient,
  InboundMessage,
  InboundMessageHandler,
  Logger,
  OutboundMessage,
} from "../core/types.js";
import type { MessageFormatter } from "../core/types.js";
import { createBaseChannel } from "./base.js";

/**
 * @brief Dependencies for createTelegramChannel.
 */
export interface TelegramChannelDeps {
  logger: Logger;
  http: HttpClient;
  credentials: CredentialStore;
  formatter: MessageFormatter;
  credentialName: string;
}

/** @brief Telegram Bot API base URL */
const TELEGRAM_API = "https://api.telegram.org";

/**
 * @brief Creates a Telegram channel adapter.
 * @param deps - Dependencies: logger, http, credentials, formatter, credentialName
 * @returns Channel implementation for Telegram
 *
 * @example
 * const telegram = createTelegramChannel({
 *   logger, http, credentials, formatter,
 *   credentialName: "telegram-bot-token",
 * });
 * await telegram.initialize({ enabled: true });
 */
export function createTelegramChannel(deps: TelegramChannelDeps): Channel {
  const { logger, http, credentials, formatter, credentialName } = deps;
  const base = createBaseChannel("telegram", "Telegram", { logger });
  let running = false;
  let botToken: string | null = null;

  /**
   * @brief Gets the bot token from the credential store.
   * @returns Bot token string
   */
  async function getToken(): Promise<string> {
    if (botToken) return botToken;
    const cred = await credentials.get(credentialName);
    botToken = cred.value;
    return botToken;
  }

  /**
   * @brief Builds the API URL for a Telegram Bot API method.
   * @param method - Telegram API method name (e.g., "getMe", "sendMessage")
   * @param token - Bot token
   * @returns Full API URL
   */
  function apiUrl(method: string, token: string): string {
    return `${TELEGRAM_API}/bot${token}/${method}`;
  }

  return {
    id: base.id,
    name: base.name,

    async initialize(_config: ChannelConfig): Promise<void> {
      try {
        const token = await getToken();

        // Verify bot token by calling getMe
        const response = await http.fetch(apiUrl("getMe", token), {
          method: "GET",
        });

        if (!response.ok) {
          throw new Error(`Telegram auth failed: ${response.status}`);
        }

        running = true;
        logger.info("Telegram channel initialized");
      } catch (err) {
        logger.error("Telegram initialization failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },

    async shutdown(): Promise<void> {
      running = false;
      botToken = null;
      logger.info("Telegram channel shut down");
    },

    async send(message: OutboundMessage): Promise<void> {
      if (!running) return;

      try {
        const token = await getToken();
        const formatted = formatter.format(message.content);

        // Split long messages for Telegram's 4096 char limit
        const chunks = formatter.splitIfNeeded(formatted, 4096);

        for (const chunk of chunks) {
          await http.fetch(apiUrl("sendMessage", token), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: message.recipientId,
              text: chunk,
              parse_mode: "HTML",
              ...(message.replyTo
                ? { reply_to_message_id: parseInt(message.replyTo, 10) }
                : {}),
            }),
          });
        }

        logger.debug("Telegram message sent", {
          chatId: message.recipientId,
          chunks: chunks.length,
        });
      } catch (err) {
        logger.error("Telegram send failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    onMessage(handler: InboundMessageHandler): void {
      base.registerHandler(handler);
    },

    /**
     * @brief Injects a Telegram update into the channel pipeline.
     * @param update - Raw Telegram update object
     * @note Called by the Telegram webhook handler when a message arrives.
     */
    async injectTelegramUpdate(update: {
      message?: {
        message_id: number;
        from: { id: number; first_name: string };
        chat: { id: number; type: string };
        text?: string;
      };
    }): Promise<void> {
      if (!running || !update.message?.text) return;

      const msg = update.message;
      const message: InboundMessage = {
        id: String(msg.message_id),
        channelId: "telegram",
        senderId: String(msg.from.id),
        content: msg.text!,
        timestamp: new Date().toISOString(),
        isGroup: msg.chat.type !== "private",
        metadata: {
          chatId: msg.chat.id,
          chatType: msg.chat.type,
          senderName: msg.from.first_name,
        },
      };

      await base.notifyHandlers(message);
    },
  } as Channel & {
    injectTelegramUpdate(update: {
      message?: {
        message_id: number;
        from: { id: number; first_name: string };
        chat: { id: number; type: string };
        text?: string;
      };
    }): Promise<void>;
  };
}
