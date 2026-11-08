import { describe, expect, it } from 'vitest'
import { toggleCenterView } from '@/state/centerView'

describe('toggleCenterView', () => {
  it('returns to conversation when settings is active', () => {
    expect(toggleCenterView('settings')).toBe('conversation')
  })

  it('opens settings from conversation', () => {
    expect(toggleCenterView('conversation')).toBe('settings')
  })

  it('opens the brain from conversation and returns when chosen again', () => {
    expect(toggleCenterView('conversation', 'brain')).toBe('brain')
    expect(toggleCenterView('brain', 'brain')).toBe('conversation')
  })

  it('switches between settings and the brain', () => {
    expect(toggleCenterView('settings', 'brain')).toBe('brain')
    expect(toggleCenterView('brain', 'settings')).toBe('settings')
  })
})
