/**
 * @fileoverview Channel subsystem public exports.
 * @module channels
 */

export { createMessageFormatter } from "./formatter.js";
export type { ChannelId } from "./formatter.js";
export { createBaseChannel, createDisabledChannel } from "./base.js";
export { createCLIChannel } from "./cli.js";
export type { CLIChannelDeps } from "./cli.js";
export { createWebChatChannel } from "./webchat.js";
export type { WebChatChannelDeps } from "./webchat.js";
export { createDiscordChannel } from "./discord.js";
export type { DiscordChannelDeps } from "./discord.js";
export { createTelegramChannel } from "./telegram.js";
export type { TelegramChannelDeps } from "./telegram.js";
