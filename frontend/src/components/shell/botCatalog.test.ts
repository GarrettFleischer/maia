import { describe, expect, it } from 'vitest'
import type { BotSummary } from '@/api/superAgentTypes'
import { withClearedUnread } from '@/components/shell/botCatalog'

function bot(overrides: Partial<BotSummary> & Pick<BotSummary, 'bot_id'>): BotSummary {
  return {
    name: overrides.bot_id,
    color: '#6f8f7a',
    instructions: '',
    pinned: false,
    archived: false,
    preview: '',
    last_message_at: null,
    unread: 0,
    running: false,
    status_line: '',
    ...overrides,
  }
}

describe('withClearedUnread', () => {
  it('zeroes unread for the selected bot and leaves others alone', () => {
    const next = withClearedUnread(
      [bot({ bot_id: 'maia', unread: 3 }), bot({ bot_id: 'coding', unread: 2 })],
      'maia',
    )
    expect(next.find((item) => item.bot_id === 'maia')?.unread).toBe(0)
    expect(next.find((item) => item.bot_id === 'coding')?.unread).toBe(2)
  })
})
