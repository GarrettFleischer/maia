import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveFrame, LiveReply, SuperAgentClient } from '@/api/superAgentTypes'
import { catchUpReply, type HeldReply, type LinkPhase } from '@/components/shell/liveReply'

export function useHeldReply(client: SuperAgentClient, onConnected: () => void): {
  held: HeldReply | null
  applyLive: (server: LiveReply | null | undefined) => void
} {
  const link = useRef<LinkPhase>('connected')
  const onConnectedRef = useRef(onConnected)
  onConnectedRef.current = onConnected
  const [held, setHeld] = useState<HeldReply | null>(null)
  const applyLive = useCallback((server: LiveReply | null | undefined) => {
    setHeld((current) => catchUpReply(current, server, link.current))
  }, [])

  useEffect(() => {
    const stopLive = client.subscribeLive?.((frame: LiveFrame) => {
      applyLive(frame.kind === 'cleared' ? null : frame.reply)
    })
    const stopLink = client.subscribeConnection?.((snapshot) => {
      const previous = link.current
      link.current = snapshot.phase
      applyLive(undefined)
      if (previous === 'reconnecting' && snapshot.phase === 'connected') {
        onConnectedRef.current()
      }
    })
    return () => {
      stopLive?.()
      stopLink?.()
    }
  }, [applyLive, client])

  return { held, applyLive }
}
