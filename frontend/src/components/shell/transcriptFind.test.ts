import { describe, expect, it } from 'vitest'
import { findMatchLabel, messageMatchesFind } from '@/components/shell/transcriptFind'

describe('messageMatchesFind', () => {
  it('matches case-insensitively and treats empty query as all', () => {
    expect(messageMatchesFind('Weather in Canby', '')).toBe(true)
    expect(messageMatchesFind('Weather in Canby', '  ')).toBe(true)
    expect(messageMatchesFind('Weather in Canby', 'canby')).toBe(true)
    expect(messageMatchesFind('Thanks', 'canby')).toBe(false)
  })
})

describe('findMatchLabel', () => {
  it('stays quiet until there is a query', () => {
    expect(findMatchLabel(3, '')).toBeNull()
    expect(findMatchLabel(1, 'canby')).toBe('1 match')
    expect(findMatchLabel(2, 'canby')).toBe('2 matches')
  })
})
