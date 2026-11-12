import type { LiveReply } from '@/api/superAgentTypes'

export type LinkPhase = 'connected' | 'reconnecting'

export interface HeldReply {
  stream_id: string
  revision: number
  text: string
  phase: LiveReply['phase']
  dots: boolean
}

/** A live partial is never the stored answer. The durable message replaces it. */
export function liveReplyCountsAsFinal(_reply: HeldReply): boolean {
  return false
}

/**
 * Applies a server snapshot onto the sentence this browser is showing.
 *
 * `undefined` means this browser learned nothing new from the server.
 * `null` means the server has no partial. A dropped link keeps the sentence
 * it already has and asks for the animated dots. A newer stream replaces it.
 */
export function catchUpReply(
  held: HeldReply | null,
  server: LiveReply | null | undefined,
  link: LinkPhase,
): HeldReply | null {
  if (server === undefined) {
    if (!held) return null
    return present(held, link)
  }
  if (server === null || server.text.length === 0) {
    if (link === 'reconnecting' && held) return present(held, link)
    return null
  }
  const adopt =
    !held || server.stream_id !== held.stream_id || server.revision >= held.revision
  const next = adopt
    ? {
        stream_id: server.stream_id,
        revision: server.revision,
        text: server.text,
        phase: server.phase,
      }
    : {
        stream_id: held.stream_id,
        revision: held.revision,
        text: held.text,
        phase: held.phase,
      }
  return present(next, link)
}

function present(
  reply: Omit<HeldReply, 'dots'>,
  link: LinkPhase,
): HeldReply {
  return {
    ...reply,
    dots: link === 'reconnecting' || reply.phase === 'interrupted',
  }
}
