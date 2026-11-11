import { describe, expect, it } from 'vitest'
import manifestText from '../../public/manifest.webmanifest?raw'
import icon192 from '../../public/icons/icon-192.png?inline'
import icon512 from '../../public/icons/icon-512.png?inline'
import icon192Mask from '../../public/icons/icon-192-maskable.png?inline'
import icon512Mask from '../../public/icons/icon-512-maskable.png?inline'

function pngSize(inline: string): { width: number; height: number } {
  const payload = inline.includes(',') ? inline.slice(inline.indexOf(',') + 1) : inline
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const signature = [...bytes.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  expect(signature).toBe('89504e470d0a1a0a')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

describe('PWA icons', () => {
  it('ships 192 and 512 any and maskable icons', () => {
    const manifest = JSON.parse(manifestText) as {
      name: string
      icons: { src: string; sizes: string; purpose: string }[]
    }
    expect(manifest.name).toBe('Maia')
    const expected = [
      ['/icons/icon-192.png', '192x192', 'any', icon192],
      ['/icons/icon-512.png', '512x512', 'any', icon512],
      ['/icons/icon-192-maskable.png', '192x192', 'maskable', icon192Mask],
      ['/icons/icon-512-maskable.png', '512x512', 'maskable', icon512Mask],
    ] as const
    expect(manifest.icons.map((icon) => [icon.src, icon.sizes, icon.purpose])).toEqual(
      expected.map(([src, sizes, purpose]) => [src, sizes, purpose]),
    )
    for (const [, sizes, , inline] of expected) {
      const [width, height] = sizes.split('x').map(Number)
      expect(pngSize(inline)).toEqual({ width, height })
    }
  })
})
