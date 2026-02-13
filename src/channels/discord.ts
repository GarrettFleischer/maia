/**
 * @fileoverview Discord bot channel adapter.
 * @module channels/discord
 *
 * @note Connects to Discord using a bot token stored in the credential store.
 * Messages are received via the Discord API (polling or webhook) and sent back
 * via REST API calls.
 *
 * @note This is a structural implementation that defines the Discord channel
 * contract. Full Discord.js integration would be added as a production
 * enhancement; this adapter uses the HttpClient abstraction for testability.
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
 * @brief Dependencies for createDiscordChannel.
 */
export interface DiscordChannelDeps {
  logger: Logger;
  http: HttpClient;
  credentials: CredentialStore;
  formatter: MessageFormatter;
  credentialName: string;
}

/** @brief Discord API base URL */
const DISCORD_API = "https://discord.com/api/v10";

/**
 * @brief Creates a Discord channel adapter.
 * @param deps - Dependencies: logger, http, credentials, formatter, credentialName
 * @returns Channel implementation for Discord
 *
 * @example
 * const discord = createDiscordChannel({
 *   logger, http, credentials, formatter,
 *   credentialName: "discord-bot-token",
 * });
 * await discord.initialize({ enabled: true });
 */
export function createDiscordChannel(deps: DiscordChannelDeps): Channel {
  const { logger, http, credentials, formatter, credentialName } = deps;
  const base = createBaseChannel("discord", "Discord", { logger });
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

  return {
    id: base.id,
    name: base.name,

    async initialize(_config: ChannelConfig): Promise<void> {
      try {
        const token = await getToken();

        // Verify bot token by fetching bot user info
        const response = await http.fetch(`${DISCORD_API}/users/@me`, {
          headers: { Authorization: `Bot ${token}` },
        });

        if (!response.ok) {
          throw new Error(`Discord auth failed: ${response.status}`);
        }

        running = true;
        logger.info("Discord channel initialized");
      } catch (err) {
        logger.error("Discord initialization failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },

    async shutdown(): Promise<void> {
      running = false;
      botToken = null;
      logger.info("Discord channel shut down");
    },

    async send(message: OutboundMessage): Promise<void> {
      if (!running) return;

      try {
        const token = await getToken();
        const formatted = formatter.format(message.content);

        // Split long messages for Discord's 2000 char limit
        const chunks = formatter.splitIfNeeded(formatted, 2000);

        for (const chunk of chunks) {
          await http.fetch(
            `${DISCORD_API}/channels/${message.recipientId}/messages`,
            {
              method: "POST",
              headers: {
                Authorization: `Bot ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                content: chunk,
                ...(message.replyTo
                  ? { message_reference: { message_id: message.replyTo } }
                  : {}),
              }),
            }
          );
        }

        logger.debug("Discord message sent", {
          channelId: message.recipientId,
          chunks: chunks.length,
        });
      } catch (err) {
        logger.error("Discord send failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    onMessage(handler: InboundMessageHandler): void {
      base.registerHandler(handler);
    },

    /**
     * @brief Injects a Discord message into the channel pipeline.
     * @param discordMessage - Raw Discord message data
     * @note Called by the Discord gateway/webhook receiver when a message arrives.
     */
    async injectDiscordMessage(discordMessage: {
      id: string;
      channel_id: string;
      author: { id: string };
      content: string;
      guild_id?: string;
    }): Promise<void> {
      if (!running) return;

      const message: InboundMessage = {
        id: discordMessage.id,
        channelId: "discord",
        senderId: discordMessage.author.id,
        content: discordMessage.content,
        timestamp: new Date().toISOString(),
        isGroup: !!discordMessage.guild_id,
        metadata: {
          discordChannelId: discordMessage.channel_id,
          guildId: discordMessage.guild_id,
        },
      };

      await base.notifyHandlers(message);
    },
  } as Channel & {
    injectDiscordMessage(discordMessage: {
      id: string;
      channel_id: string;
      author: { id: string };
      content: string;
      guild_id?: string;
    }): Promise<void>;
  };
}
