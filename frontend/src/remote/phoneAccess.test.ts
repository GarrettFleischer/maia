import { describe, expect, it } from 'vitest'
import { isTailnetOrigin, readDesktopPhoneStatus } from '@/remote/phoneAccess'

describe('isTailnetOrigin', () => {
  it('accepts the Tailscale HTTPS name and rejects loopback', () => {
    expect(isTailnetOrigin('https://gamma.tailc7a62f.ts.net:4178')).toBe(true)
    expect(isTailnetOrigin('http://127.0.0.1:5173')).toBe(false)
    expect(isTailnetOrigin('http://gamma.tailc7a62f.ts.net:4178')).toBe(false)
    expect(isTailnetOrigin('https://evil.example')).toBe(false)
  })
})

describe('readDesktopPhoneStatus', () => {
  it('reads a ready listener and drops a malformed payload', () => {
    expect(
      readDesktopPhoneStatus({
        enabled: true,
        phase: 'ready',
        url: 'https://gamma.tailc7a62f.ts.net:4178/',
        reason: null,
        code_active: false,
        devices: [{ node_id: 'node-1', name: 'Pixel', paired_at: 10 }],
      })?.url,
    ).toBe('https://gamma.tailc7a62f.ts.net:4178/')
    expect(readDesktopPhoneStatus({ enabled: true })).toBeNull()
  })
})
