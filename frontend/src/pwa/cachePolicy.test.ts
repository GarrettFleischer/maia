import { describe, expect, it } from 'vitest'
import { isBlockedFromCache, resolveCacheStrategy, shouldInterceptRequest } from '@/pwa/cachePolicy'

describe('service worker cache policy', () => {
  it('never caches api or websocket routes', () => {
    expect(isBlockedFromCache('/api/security/profile')).toBe(true)
    expect(isBlockedFromCache('/ws/events')).toBe(true)
    expect(shouldInterceptRequest('/api/threads/1')).toBe(false)
    expect(shouldInterceptRequest('/ws')).toBe(false)
  })

  it('never caches vault secrets or audit paths', () => {
    for (const path of ['/vault/notes', '/secrets/backend', '/audit/chain']) {
      expect(isBlockedFromCache(path)).toBe(true)
      expect(shouldInterceptRequest(path)).toBe(false)
    }
  })

  it('caches static shell assets only', () => {
    expect(resolveCacheStrategy('/', 'navigate')).toBe('network_first_document')
    expect(resolveCacheStrategy('/assets/index-abc.js', 'same-origin')).toBe('cache_first_asset')
    expect(resolveCacheStrategy('/icons/icon-192.png', 'same-origin')).toBe('cache_first_asset')
  })
})
