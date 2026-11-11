import { describe, expect, it } from 'vitest'
import { COMPOSER_MAX_PX, COMPOSER_MIN_PX, composerFieldPx } from '@/components/shell/composerField'

describe('composerFieldPx', () => {
  it('starts at one short field and stops growing at six lines', () => {
    expect(composerFieldPx(0)).toBe(COMPOSER_MIN_PX)
    expect(composerFieldPx(80)).toBe(80)
    expect(composerFieldPx(400)).toBe(COMPOSER_MAX_PX)
    expect(COMPOSER_MAX_PX).toBe(144)
  })
})
