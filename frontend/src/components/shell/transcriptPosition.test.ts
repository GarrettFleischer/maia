import { describe, expect, it } from 'vitest'
import { shouldFollowTranscript } from '@/components/shell/transcriptPosition'

describe('shouldFollowTranscript', () => {
  it('follows successful hydration and only appends observed at the bottom', () => {
    expect(shouldFollowTranscript('hydrate', false)).toBe(true)
    expect(shouldFollowTranscript('hydrate', true)).toBe(true)
    expect(shouldFollowTranscript('append', true)).toBe(true)
    expect(shouldFollowTranscript('append', false)).toBe(false)
  })
})
