import type { BotSummary } from '@/api/superAgentTypes'

/** Clears the unread badge for the bot the owner just opened. */
export function withClearedUnread(bots: readonly BotSummary[], botId: string): BotSummary[] {
  return bots.map((bot) =>
    bot.bot_id === botId && bot.unread > 0 ? { ...bot, unread: 0 } : bot,
  )
}
