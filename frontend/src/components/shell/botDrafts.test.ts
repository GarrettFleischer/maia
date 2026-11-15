import { describe, expect, it } from 'vitest'
import { clearBotDraft, readBotDraft, writeBotDraft } from '@/components/shell/botDrafts'

describe('botDrafts', () => {
  it('reads an empty string when no draft is stored for that bot', () => {
    expect(readBotDraft({}, 'maia')).toBe('')
    expect(readBotDraft({ coding: 'hi' }, 'maia')).toBe('')
  })

  it('writes and clears drafts per bot without touching others', () => {
    const withMaia = writeBotDraft({}, 'maia', 'Ask about weather')
    expect(readBotDraft(withMaia, 'maia')).toBe('Ask about weather')

    const withBoth = writeBotDraft(withMaia, 'coding', 'Fix the build')
    expect(readBotDraft(withBoth, 'maia')).toBe('Ask about weather')
    expect(readBotDraft(withBoth, 'coding')).toBe('Fix the build')

    const cleared = clearBotDraft(withBoth, 'maia')
    expect(readBotDraft(cleared, 'maia')).toBe('')
    expect(readBotDraft(cleared, 'coding')).toBe('Fix the build')
  })

  it('drops empty or whitespace drafts instead of storing blank strings', () => {
    const seeded = writeBotDraft({}, 'maia', 'keep')
    expect(writeBotDraft(seeded, 'maia', '')).toEqual({})
    expect(writeBotDraft(seeded, 'maia', '   ')).toEqual({})
  })
})
