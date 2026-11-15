/** Honest leaf: whether a message body matches an active Find query. */
export function messageMatchesFind(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return false
  return text.toLowerCase().includes(needle)
}

/** Honest leaf: ordered message ids that match the Find query. */
export function findMatchIds(
  messages: readonly { message_id: string; text: string }[],
  query: string,
): string[] {
  if (query.trim().length === 0) return []
  return messages
    .filter((message) => messageMatchesFind(message.text, query))
    .map((message) => message.message_id)
}

/** Honest leaf: status label for the active Find hit. */
export function findMatchLabel(
  activeIndex: number,
  matchCount: number,
  query: string,
): string | null {
  if (query.trim().length === 0) return null
  if (matchCount === 0) return 'No matches'
  return `${activeIndex + 1} of ${matchCount}`
}

/** Honest leaf: wrap Prev/Next across the match list. */
export function stepFindIndex(
  activeIndex: number,
  matchCount: number,
  direction: 'next' | 'prev',
): number {
  if (matchCount <= 0) return 0
  if (direction === 'next') return (activeIndex + 1) % matchCount
  return (activeIndex - 1 + matchCount) % matchCount
}
