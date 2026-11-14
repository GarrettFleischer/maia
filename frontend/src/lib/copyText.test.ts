import { describe, expect, it, vi } from 'vitest'
import { copyText } from '@/lib/copyText'

describe('copyText', () => {
  it('reports copied when the clipboard accepts the text', async () => {
    const writeText = vi.fn(async () => undefined)
    expect(await copyText('hello', { writeText })).toBe('copied')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('reports failed when the clipboard rejects', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied')
    })
    expect(await copyText('hello', { writeText })).toBe('failed')
  })
})
