/** Honest leaf: draft text stored for one bot, or empty when none. */
export function readBotDraft(
  store: Readonly<Record<string, string>>,
  botId: string,
): string {
  return store[botId] ?? ''
}

/** Honest leaf: set a bot's draft; blank or whitespace clears that bot. */
export function writeBotDraft(
  store: Readonly<Record<string, string>>,
  botId: string,
  draft: string,
): Record<string, string> {
  if (draft.trim().length === 0) return clearBotDraft(store, botId)
  return { ...store, [botId]: draft }
}

/** Honest leaf: drop a bot's draft without touching others. */
export function clearBotDraft(
  store: Readonly<Record<string, string>>,
  botId: string,
): Record<string, string> {
  if (!(botId in store)) return store
  const next = { ...store }
  delete next[botId]
  return next
}
