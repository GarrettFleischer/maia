import { describe, expect, it } from 'vitest'
import { keyboardInsetPx } from '@/components/shell/keyboardInset'

describe('keyboardInsetPx', () => {
  it('measures the gap the on-screen keyboard takes from the layout viewport', () => {
    expect(keyboardInsetPx(800, 800, 0)).toBe(0)
    expect(keyboardInsetPx(800, 470, 0)).toBe(330)
    expect(keyboardInsetPx(800, 500, 20)).toBe(280)
    expect(keyboardInsetPx(Number.NaN, 100, 0)).toBe(0)
  })
})
