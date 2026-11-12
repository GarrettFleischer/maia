/** A sent message kept on this device until the daemon accepts it. */

export interface OutboxItem {
  operationId: string
  text: string
  attachmentIds: string[]
  at: number
}

const MAIA_KEY = 'maia.outbox.v1'

export function outboxKey(botId = 'maia'): string {
  return botId === 'maia' ? MAIA_KEY : `${MAIA_KEY}.${botId}`
}

export function loadOutbox(botId = 'maia'): OutboxItem[] {
  try {
    const raw = localStorage.getItem(outboxKey(botId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isItem).sort((left, right) => left.at - right.at)
  } catch {
    return []
  }
}

export function enqueueOutbox(item: OutboxItem, botId = 'maia'): void {
  const rest = loadOutbox(botId).filter((entry) => entry.operationId !== item.operationId)
  rest.push(item)
  localStorage.setItem(outboxKey(botId), JSON.stringify(rest.sort((left, right) => left.at - right.at)))
}

export function dropOutbox(operationId: string, botId = 'maia'): void {
  const rest = loadOutbox(botId).filter((entry) => entry.operationId !== operationId)
  localStorage.setItem(outboxKey(botId), JSON.stringify(rest))
}

function isItem(value: unknown): value is OutboxItem {
  if (!value || typeof value !== 'object') return false
  const item = value as OutboxItem
  return typeof item.operationId === 'string' && typeof item.text === 'string' && Array.isArray(item.attachmentIds)
}
