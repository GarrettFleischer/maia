import { describe, expect, it } from 'vitest'
import {
  findMatchIds,
  findMatchLabel,
  messageMatchesFind,
  stepFindIndex,
} from '@/components/shell/transcriptFind'

describe('messageMatchesFind', () => {
  it('matches case-insensitively and treats empty query as no active search', () => {
    expect(messageMatchesFind('Weather in Canby', '')).toBe(false)
    expect(messageMatchesFind('Weather in Canby', '  ')).toBe(false)
    expect(messageMatchesFind('Weather in Canby', 'canby')).toBe(true)
    expect(messageMatchesFind('Thanks', 'canby')).toBe(false)
  })
})

describe('findMatchIds', () => {
  it('returns message ids that match the query in order', () => {
    const messages = [
      { message_id: 'm1', text: 'Weather in Canby' },
      { message_id: 'm2', text: 'It is raining' },
      { message_id: 'm3', text: 'Canby again' },
    ]
    expect(findMatchIds(messages, '')).toEqual([])
    expect(findMatchIds(messages, 'canby')).toEqual(['m1', 'm3'])
  })
})

describe('findMatchLabel', () => {
  it('stays quiet until there is a query', () => {
    expect(findMatchLabel(0, 0, '')).toBeNull()
    expect(findMatchLabel(0, 1, 'canby')).toBe('1 of 1')
    expect(findMatchLabel(1, 3, 'canby')).toBe('2 of 3')
    expect(findMatchLabel(0, 0, 'canby')).toBe('No matches')
  })
})

describe('stepFindIndex', () => {
  it('wraps forward and backward across matches', () => {
    expect(stepFindIndex(0, 3, 'next')).toBe(1)
    expect(stepFindIndex(2, 3, 'next')).toBe(0)
    expect(stepFindIndex(0, 3, 'prev')).toBe(2)
    expect(stepFindIndex(1, 3, 'prev')).toBe(0)
    expect(stepFindIndex(0, 0, 'next')).toBe(0)
  })
})
