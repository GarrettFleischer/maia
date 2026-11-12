import { describe, expect, it } from 'vitest'
import { shouldFollowTranscript } from '@/components/shell/transcriptPosition'

describe('shouldFollowTranscript', () => {
  it('follows successful hydration and only appends observed at the bottom', () => {
    expect(shouldFollowTranscript('hydrate', false)).toBe(true)
    expect(shouldFollowTranscript('hydrate', true)).toBe(true)
    expect(shouldFollowTranscript('append', true)).toBe(true)
    expect(shouldFollowTranscript('append', false)).toBe(false)
  })

  it('holds a hydrated transcript when an unseen divider is waiting', () => {
    expect(shouldFollowTranscript('hydrate', true, true)).toBe(false)
    expect(shouldFollowTranscript('append', true, true)).toBe(true)
  })
})
