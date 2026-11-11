import { describe, expect, it } from 'vitest'
import { installSettingsLine, isInstalledDisplay } from '@/pwa/installPrompt'

describe('install prompt copy', () => {
  it('treats standalone display as installed and otherwise tells the owner how to add it', () => {
    expect(isInstalledDisplay(true, false)).toBe(true)
    expect(isInstalledDisplay(false, true)).toBe(true)
    expect(isInstalledDisplay(false, false)).toBe(false)
    expect(installSettingsLine(true)).toBe('Installed')
    expect(installSettingsLine(false)).toBe('In Chrome: Menu → Install app / Add to Home screen.')
  })
})
