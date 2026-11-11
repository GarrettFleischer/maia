import { describe, expect, it } from 'vitest'
import html from '../../index.html?raw'
import css from './mint-ledger.css?raw'

describe('phone chrome', () => {
  it('covers the viewport, resizes with the keyboard, and keeps safe areas', () => {
    expect(html).toContain('viewport-fit=cover')
    expect(html).toContain('interactive-widget=resizes-content')
    expect(css).toContain('100dvh')
    expect(css).toContain('env(safe-area-inset-top')
    expect(css).toContain('env(safe-area-inset-bottom')
    expect(css).toContain('--keyboard-inset')
    expect(css).toContain('max-height: 144px')
    expect(css).not.toContain('height: 56px;\n  resize: none;')
  })
})
