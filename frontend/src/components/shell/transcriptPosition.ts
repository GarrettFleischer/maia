import { useEffect, useLayoutEffect, useRef, useState, type UIEventHandler } from 'react'
import type { TranscriptState } from '@/api/superAgentTypes'

export type TranscriptChange = 'hydrate' | 'append'

export function shouldFollowTranscript(
  change: TranscriptChange,
  wasPinned: boolean,
): boolean {
  return change === 'hydrate' || wasPinned
}

export function useTranscriptPosition(messageKey: string, state: TranscriptState) {
  const transcriptRef = useRef<HTMLDivElement>(null)
  const hydratedRef = useRef(false)
  const previousMessageKeyRef = useRef('')
  const pinnedRef = useRef(true)
  const [latestOffer, setLatestOffer] = useState(false)

  useLayoutEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return

    if (state.kind === 'loading' && messageKey.length === 0) {
      hydratedRef.current = false
      previousMessageKeyRef.current = ''
      pinnedRef.current = true
      return
    }
    if (state.kind !== 'ready' && state.kind !== 'empty') return

    const change: TranscriptChange | null = !hydratedRef.current
      ? 'hydrate'
      : messageKey !== previousMessageKeyRef.current
        ? 'append'
        : null
    if (change && shouldFollowTranscript(change, pinnedRef.current)) {
      transcript.scrollTop = transcript.scrollHeight
      setLatestOffer(false)
    } else if (change === 'append') {
      setLatestOffer(true)
    }
    hydratedRef.current = true
    previousMessageKeyRef.current = messageKey
    pinnedRef.current =
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 2
  }, [messageKey, state.kind])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const follow = () => {
      const transcript = transcriptRef.current
      if (!transcript || !pinnedRef.current) return
      transcript.scrollTop = transcript.scrollHeight
    }
    viewport.addEventListener('resize', follow)
    viewport.addEventListener('scroll', follow)
    return () => {
      viewport.removeEventListener('resize', follow)
      viewport.removeEventListener('scroll', follow)
    }
  }, [])

  useLayoutEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return
      transcript.scrollTop = transcript.scrollHeight
    })
    observer.observe(transcript)
    return () => observer.disconnect()
  }, [])

  const onScroll: UIEventHandler<HTMLDivElement> = (event) => {
    const transcript = event.currentTarget
    const pinned =
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 2
    pinnedRef.current = pinned
    if (pinned) setLatestOffer(false)
  }

  const jumpToLatest = () => {
    const transcript = transcriptRef.current
    pinnedRef.current = true
    setLatestOffer(false)
    if (transcript) transcript.scrollTop = transcript.scrollHeight
  }

  return { transcriptRef, onScroll, latestOffer, jumpToLatest }
}
