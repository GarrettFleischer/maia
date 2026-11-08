import { describe, expect, it } from 'vitest'
import {
  navigationUpdatePreference,
  resolveCacheStrategy,
  SW_CACHE_NAME,
} from '@/pwa/cachePolicy'

describe('resolveCacheStrategy', () => {
  it('never intercepts sensitive routes', () => {
    expect(resolveCacheStrategy('/api/security/profile', 'cors')).toBe('network_only')
    expect(resolveCacheStrategy('/ws/events', 'cors')).toBe('network_only')
    expect(resolveCacheStrategy('/vault/notes', 'same-origin')).toBe('network_only')
  })

  it('uses network-first for navigations so deploys cannot pin stale index.html', () => {
    expect(resolveCacheStrategy('/', 'navigate')).toBe('network_first_document')
    expect(resolveCacheStrategy('/settings', 'navigate')).toBe('network_first_document')
  })

  it('allows cache-first only for hashed static assets', () => {
    expect(resolveCacheStrategy('/assets/index-BcbSGEwB.js', 'same-origin')).toBe('cache_first_asset')
    expect(resolveCacheStrategy('/icons/icon-192.png', 'same-origin')).toBe('cache_first_asset')
  })
})

describe('navigationUpdatePreference', () => {
  it('prefers network response over cached shell when both exist', () => {
    expect(navigationUpdatePreference({ hasCachedDocument: true, networkOk: true })).toBe('use_network')
  })

  it('falls back to cached shell only when network fails', () => {
    expect(navigationUpdatePreference({ hasCachedDocument: true, networkOk: false })).toBe('use_cache_fallback')
  })

  it('bumps cache name when shell version changes', () => {
    expect(SW_CACHE_NAME).toMatch(/maia-static-v\d+/)
  })
})
