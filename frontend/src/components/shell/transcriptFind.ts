/** Honest leaf: whether a message body matches the Find-in-chat query. */
export function messageMatchesFind(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return text.toLowerCase().includes(needle)
}

/** Honest leaf: label for the Find match count status. */
export function findMatchLabel(count: number, query: string): string | null {
  if (query.trim().length === 0) return null
  if (count === 1) return '1 match'
  return `${count} matches`
}
