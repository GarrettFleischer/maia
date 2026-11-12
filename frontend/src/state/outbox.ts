/** A sent message kept on this device until the daemon accepts it. */

export interface OutboxItem {
  operationId: string
  text: string
  attachmentIds: string[]
  at: number
}

const KEY = 'maia.outbox.v1'

export function loadOutbox(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isItem).sort((left, right) => left.at - right.at)
  } catch {
    return []
  }
}

export function enqueueOutbox(item: OutboxItem): void {
  const rest = loadOutbox().filter((entry) => entry.operationId !== item.operationId)
  rest.push(item)
  localStorage.setItem(KEY, JSON.stringify(rest.sort((left, right) => left.at - right.at)))
}

export function dropOutbox(operationId: string): void {
  const rest = loadOutbox().filter((entry) => entry.operationId !== operationId)
  localStorage.setItem(KEY, JSON.stringify(rest))
}

function isItem(value: unknown): value is OutboxItem {
  if (!value || typeof value !== 'object') return false
  const item = value as OutboxItem
  return typeof item.operationId === 'string' && typeof item.text === 'string' && Array.isArray(item.attachmentIds)
}
