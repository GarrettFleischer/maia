import { describe, expect, it } from 'vitest'
import { catchUpReply, liveReplyCountsAsFinal, type HeldReply } from '@/components/shell/liveReply'
import type { LiveReply } from '@/api/superAgentTypes'

const held: HeldReply = {
  stream_id: '4',
  revision: 2,
  text: 'The pin is',
  phase: 'streaming',
  dots: false,
}

function server(overrides: Partial<LiveReply> = {}): LiveReply {
  return {
    bot_id: 'maia',
    stream_id: '4',
    revision: 3,
    text: 'The pin is ready',
    phase: 'streaming',
    ...overrides,
  }
}

describe('catchUpReply', () => {
  it('keeps the received sentence and shows dots when the link drops', () => {
    const next = catchUpReply(held, undefined, 'reconnecting')
    expect(next?.text).toBe('The pin is')
    expect(next?.dots).toBe(true)
  })

  it('jumps to a newer server snapshot instead of keeping a stale partial', () => {
    const next = catchUpReply(held, server(), 'connected')
    expect(next).toMatchObject({
      stream_id: '4',
      revision: 3,
      text: 'The pin is ready',
      dots: false,
    })
  })

  it('replaces the sentence when the server starts a new stream', () => {
    const next = catchUpReply(held, server({ stream_id: '5', revision: 1, text: 'Next' }), 'connected')
    expect(next?.text).toBe('Next')
    expect(next?.stream_id).toBe('5')
  })

  it('does not roll back to an older revision of the same stream', () => {
    const next = catchUpReply(held, server({ revision: 1, text: 'The' }), 'connected')
    expect(next?.text).toBe('The pin is')
    expect(next?.revision).toBe(2)
  })

  it('marks an interrupted stream without pretending it is still writing', () => {
    const next = catchUpReply(held, server({ phase: 'interrupted', text: 'The pin is' }), 'connected')
    expect(next?.dots).toBe(false)
    expect(next?.phase).toBe('interrupted')
    expect(next?.text).toBe('The pin is')
  })

  it('keeps a dismissed interrupted stream cleared while the same stream remains', () => {
    const next = catchUpReply(
      held,
      server({ phase: 'interrupted', text: 'The pin is' }),
      'connected',
      new Set(['4']),
    )
    expect(next).toBeNull()
  })

  it('adopts a newer stream after an interrupted one was dismissed', () => {
    const next = catchUpReply(
      null,
      server({ stream_id: '5', revision: 1, text: 'Fresh', phase: 'streaming' }),
      'connected',
      new Set(['4']),
    )
    expect(next?.stream_id).toBe('5')
    expect(next?.text).toBe('Fresh')
  })

  it('drops the partial once the server clears it and the link is up', () => {
    expect(catchUpReply(held, null, 'connected')).toBeNull()
  })

  it('keeps the received sentence when a clear arrives while the link is down', () => {
    const next = catchUpReply(held, null, 'reconnecting')
    expect(next?.text).toBe('The pin is')
    expect(next?.dots).toBe(true)
  })

  it('does not treat a half-finished stream as the final answer', () => {
    const partial = catchUpReply(null, server({ text: 'Half' }), 'connected')
    expect(partial).not.toBeNull()
    expect(liveReplyCountsAsFinal(partial!)).toBe(false)
  })
})
