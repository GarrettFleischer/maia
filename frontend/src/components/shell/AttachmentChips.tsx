import type { AttachmentChip } from '@/api/superAgentTypes'

export const ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'application/pdf',
] as const

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export function attachmentAllowed(mediaType: string, byteSize: number): boolean {
  return (
    (ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(mediaType) &&
    byteSize > 0 &&
    byteSize <= MAX_ATTACHMENT_BYTES
  )
}

export function imagePreview(mediaType: string): boolean {
  return (
    mediaType === 'image/png' ||
    mediaType === 'image/jpeg' ||
    mediaType === 'image/gif' ||
    mediaType === 'image/webp'
  )
}

export function AttachmentChips({
  chips,
  onRemove,
}: {
  chips: readonly AttachmentChip[]
  onRemove?: (attachmentId: string) => void
}) {
  if (chips.length === 0) return null
  return (
    <ul className="maia-attachment-chips" aria-label="Attachments">
      {chips.map((chip) => (
        <li key={chip.attachment_id}>
          {imagePreview(chip.media_type) ? (
            <img
              src={`/api/super-agent/attachments/${encodeURIComponent(chip.attachment_id)}`}
              alt={chip.safe_name}
            />
          ) : (
            <span>{chip.safe_name}</span>
          )}
          {onRemove ? (
            <button type="button" onClick={() => onRemove(chip.attachment_id)}>
              Remove {chip.safe_name}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
