/**
 * @fileoverview Channel-specific message formatters. Converts markdown/URLs for
 * Discord, Telegram, CLI, and WebChat.
 * @module channels/formatter
 */

import type { MessageFormatter } from "../core/types.js";

/** @brief Supported channel identifiers. */
export type ChannelId = "discord" | "telegram" | "cli" | "webchat";

/**
 * @brief Creates a message formatter for the given channel.
 * @param channel - Channel id: discord, telegram, cli, or webchat
 * @returns MessageFormatter with format and splitIfNeeded methods
 */
export function createMessageFormatter(channel: ChannelId): MessageFormatter {
  function format(content: string): string {
    switch (channel) {
      case "discord": {
        let out = content;
        out = out.replace(/^#+\s+(.+)$/gm, "**$1**");
        out = out.replace(/(?<![<>])(https?:\/\/[^\s<>]+)(?![<>])/g, "<$1>");
        return out;
      }
      case "telegram": {
        let out = content;
        out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
        out = out.replace(/\*(.+?)\*/g, "<i>$1</i>");
        out = out.replace(/`(.+?)`/g, "<code>$1</code>");
        return out;
      }
      case "cli":
      case "webchat":
      default:
        return content;
    }
  }

  function splitIfNeeded(content: string, max: number): string[] {
    if (max === Infinity || content.length <= max) {
      return [content];
    }
    const chunks: string[] = [];
    let remaining = content;
    while (remaining.length > max) {
      const slice = remaining.slice(0, max);
      const lastNewline = slice.lastIndexOf("\n");
      const splitAt = lastNewline >= 0 ? lastNewline + 1 : max;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    if (remaining.length > 0) {
      chunks.push(remaining);
    }
    return chunks;
  }

  return {
    format,
    splitIfNeeded(content: string, maxLength: number): string[] {
      return splitIfNeeded(content, maxLength);
    },
  };
}
