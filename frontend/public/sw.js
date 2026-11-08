/* Hand-written service worker — keep fetch policy aligned with src/pwa/cachePolicy.ts */
const CACHE_NAME = 'maia-static-v2'
const BLOCKED_PREFIXES = ['/api', '/ws', '/vault', '/secrets', '/audit']

function isBlocked(pathname) {
  return BLOCKED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

function resolveCacheStrategy(pathname, mode) {
  if (isBlocked(pathname)) {
    return 'network_only'
  }
  if (mode === 'navigate' || pathname === '/' || pathname.endsWith('.html')) {
    return 'network_first_document'
  }
  if (
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname.endsWith('.js') ||
    pathname.endsWith('.css') ||
    pathname.endsWith('.svg')
  ) {
    return 'cache_first_asset'
  }
  return 'network_only'
}

async function networkFirstDocument(request) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (response.ok) {
      await cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    const cached = await cache.match(request)
    if (cached) {
      return cached
    }
    throw error
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached) {
    return cached
  }
  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())
  }
  return response
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET') {
    return
  }
  const strategy = resolveCacheStrategy(url.pathname, event.request.mode)
  if (strategy === 'network_only') {
    return
  }
  if (strategy === 'network_first_document') {
    event.respondWith(networkFirstDocument(event.request))
    return
  }
  event.respondWith(cacheFirstAsset(event.request))
})
