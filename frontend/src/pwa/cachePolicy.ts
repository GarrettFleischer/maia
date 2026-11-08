/** Pure cache policy shared with the hand-written service worker (keep in sync). */

const BLOCKED_PREFIXES = [
  '/api',
  '/ws',
  '/vault',
  '/secrets',
  '/audit',
] as const

export const SW_CACHE_NAME = 'maia-static-v2'

export type CacheStrategy = 'network_only' | 'network_first_document' | 'cache_first_asset'

export function isBlockedFromCache(urlPathname: string): boolean {
  return BLOCKED_PREFIXES.some((prefix) => urlPathname.startsWith(prefix))
}

export function resolveCacheStrategy(urlPathname: string, mode: RequestMode): CacheStrategy {
  if (isBlockedFromCache(urlPathname)) {
    return 'network_only'
  }
  if (mode === 'navigate' || urlPathname === '/' || urlPathname.endsWith('.html')) {
    return 'network_first_document'
  }
  if (
    urlPathname.startsWith('/assets/') ||
    urlPathname.startsWith('/icons/') ||
    urlPathname.endsWith('.js') ||
    urlPathname.endsWith('.css') ||
    urlPathname.endsWith('.svg')
  ) {
    return 'cache_first_asset'
  }
  return 'network_only'
}

export function navigationUpdatePreference(input: {
  hasCachedDocument: boolean
  networkOk: boolean
}): 'use_network' | 'use_cache_fallback' | 'network_error' {
  if (input.networkOk) {
    return 'use_network'
  }
  if (input.hasCachedDocument) {
    return 'use_cache_fallback'
  }
  return 'network_error'
}

export function shouldInterceptRequest(urlPathname: string, mode: RequestMode = 'same-origin'): boolean {
  return resolveCacheStrategy(urlPathname, mode) !== 'network_only'
}

export { BLOCKED_PREFIXES }
