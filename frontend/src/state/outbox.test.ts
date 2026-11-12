import { dropOutbox, enqueueOutbox, loadOutbox } from '@/state/outbox'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(() => localStorage.clear())

describe('outbox', () => {
  it('keeps an unsent message across a reload and drops it once accepted', () => {
    enqueueOutbox({ operationId: 'op-1', text: 'Remember the flour', attachmentIds: [], at: 2 })
    enqueueOutbox({ operationId: 'op-0', text: 'Earlier', attachmentIds: ['file-1'], at: 1 })
    expect(loadOutbox().map((item) => item.operationId)).toEqual(['op-0', 'op-1'])
    dropOutbox('op-0')
    expect(loadOutbox()).toEqual([
      { operationId: 'op-1', text: 'Remember the flour', attachmentIds: [], at: 2 },
    ])
  })

  it('does not store a second copy of the same operation', () => {
    enqueueOutbox({ operationId: 'op-1', text: 'Once', attachmentIds: [], at: 1 })
    enqueueOutbox({ operationId: 'op-1', text: 'Once', attachmentIds: [], at: 2 })
    expect(loadOutbox()).toHaveLength(1)
  })
})
