import { describe, expect, it } from 'vitest'
import { readThemeChoice, themeAttribute } from '@/theme/documentTheme'

describe('document theme', () => {
  it('defaults to dark and resolves system from the platform preference', () => {
    expect(readThemeChoice(null)).toBe('dark')
    expect(readThemeChoice('nope')).toBe('dark')
    expect(themeAttribute('dark', false)).toBe('dark')
    expect(themeAttribute('light', true)).toBe('light')
    expect(themeAttribute('system', true)).toBe('dark')
    expect(themeAttribute('system', false)).toBe('light')
  })
})
