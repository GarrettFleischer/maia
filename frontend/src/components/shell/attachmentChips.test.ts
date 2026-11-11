import { describe, expect, it } from 'vitest'
import { attachmentAllowed, imagePreview } from '@/components/shell/AttachmentChips'

describe('attachment chips', () => {
  it('allows images, text, and pdf under 10 MB and never treats markup as a preview', () => {
    expect(attachmentAllowed('text/plain', 12)).toBe(true)
    expect(attachmentAllowed('application/pdf', 12)).toBe(true)
    expect(attachmentAllowed('image/png', 10 * 1024 * 1024)).toBe(true)
    expect(attachmentAllowed('image/png', 10 * 1024 * 1024 + 1)).toBe(false)
    expect(attachmentAllowed('text/html', 12)).toBe(false)
    expect(attachmentAllowed('image/svg+xml', 12)).toBe(false)
    expect(imagePreview('image/png')).toBe(true)
    expect(imagePreview('text/plain')).toBe(false)
    expect(imagePreview('image/svg+xml')).toBe(false)
  })
})
