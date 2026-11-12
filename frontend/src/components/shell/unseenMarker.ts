export interface UnseenView {
  seenId: string | null
  unseenIndex: number | null
}

export function seenKey(botId: string): string {
  return `maia-seen:${botId}`
}

export function readSeenCursor(storage: Pick<Storage, 'getItem'>, botId: string): string | null {
  const value = storage.getItem(seenKey(botId))
  return value && value.length > 0 ? value : null
}

export function writeSeenCursor(
  storage: Pick<Storage, 'setItem'>,
  botId: string,
  messageId: string,
): void {
  storage.setItem(seenKey(botId), messageId)
}

/**
 * Places the New line above the first stored message after the seen cursor.
 *
 * A missing cursor baselines to the latest message so existing history is not
 * marked new. Reaching the latest message advances the cursor.
 */
export function cursorAfterView(
  ids: readonly string[],
  seenId: string | null,
  viewingLatest: boolean,
): UnseenView {
  if (ids.length === 0) return { seenId, unseenIndex: null }
  const last = ids[ids.length - 1] ?? null
  if (seenId === null || !ids.includes(seenId)) {
    return { seenId: last, unseenIndex: null }
  }
  if (viewingLatest) return { seenId: last, unseenIndex: null }
  const at = ids.indexOf(seenId)
  if (at < 0 || at >= ids.length - 1) return { seenId, unseenIndex: null }
  return { seenId, unseenIndex: at + 1 }
}
