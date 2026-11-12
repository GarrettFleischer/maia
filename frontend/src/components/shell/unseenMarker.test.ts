import { describe, expect, it } from 'vitest'
import {
  cursorAfterView,
  readSeenCursor,
  seenKey,
  writeSeenCursor,
} from '@/components/shell/unseenMarker'

const ids = ['m1', 'm2', 'm3']

describe('cursorAfterView', () => {
  it('baselines a first visit to the latest message and shows no New line', () => {
    expect(cursorAfterView(ids, null, false)).toEqual({ seenId: 'm3', unseenIndex: null })
  })

  it('puts the New line above the first message after the seen cursor', () => {
    expect(cursorAfterView(ids, 'm1', false)).toEqual({ seenId: 'm1', unseenIndex: 1 })
  })

  it('shows no New line when the seen cursor is the latest message', () => {
    expect(cursorAfterView(ids, 'm3', false)).toEqual({ seenId: 'm3', unseenIndex: null })
  })

  it('baselines again when the saved message is gone', () => {
    expect(cursorAfterView(ids, 'missing', false)).toEqual({ seenId: 'm3', unseenIndex: null })
  })

  it('advances the cursor to the latest message once that message is in view', () => {
    expect(cursorAfterView(ids, 'm1', true)).toEqual({ seenId: 'm3', unseenIndex: null })
  })

  it('keeps an empty transcript without inventing a cursor', () => {
    expect(cursorAfterView([], null, true)).toEqual({ seenId: null, unseenIndex: null })
  })
})

describe('seen cursor storage', () => {
  it('round-trips the seen message id for one bot', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
    expect(readSeenCursor(storage, 'maia')).toBeNull()
    writeSeenCursor(storage, 'maia', 'm2')
    expect(values.get(seenKey('maia'))).toBe('m2')
    expect(readSeenCursor(storage, 'maia')).toBe('m2')
    expect(readSeenCursor(storage, 'other')).toBeNull()
  })
})
