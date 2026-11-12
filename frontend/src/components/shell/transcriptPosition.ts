import { useEffect, useLayoutEffect, useRef, useState, type UIEventHandler } from 'react'
import type { TranscriptState } from '@/api/superAgentTypes'

export type TranscriptChange = 'hydrate' | 'append'

export function shouldFollowTranscript(
  change: TranscriptChange,
  wasPinned: boolean,
  holdUnseen = false,
): boolean {
  if (holdUnseen && change === 'hydrate') return false
  return change === 'hydrate' || wasPinned
}

export function useTranscriptPosition(
  messageKey: string,
  state: TranscriptState,
  holdUnseen = false,
) {
  const transcriptRef = useRef<HTMLDivElement>(null)
  const hydratedRef = useRef(false)
  const previousMessageKeyRef = useRef('')
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)
  const [latestOffer, setLatestOffer] = useState(false)

  useLayoutEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return

    if (state.kind === 'loading' && messageKey.length === 0) {
      hydratedRef.current = false
      previousMessageKeyRef.current = ''
      pinnedRef.current = true
      setPinned(true)
      return
    }
    if (state.kind !== 'ready' && state.kind !== 'empty') return

    const change: TranscriptChange | null = !hydratedRef.current
      ? 'hydrate'
      : messageKey !== previousMessageKeyRef.current
        ? 'append'
        : null
    if (change && shouldFollowTranscript(change, pinnedRef.current, holdUnseen)) {
      transcript.scrollTop = transcript.scrollHeight
      setLatestOffer(false)
    } else if (change === 'append') {
      setLatestOffer(true)
    }
    hydratedRef.current = true
    previousMessageKeyRef.current = messageKey
    const nextPinned =
      transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 2
    pinnedRef.current = nextPinned
    setPinned(nextPinned)
  }, [holdUnseen, messageKey, state.kind])

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
    setPinned(pinned)
    if (pinned) setLatestOffer(false)
  }

  const jumpToLatest = () => {
    const transcript = transcriptRef.current
    pinnedRef.current = true
    setPinned(true)
    setLatestOffer(false)
    if (transcript) transcript.scrollTop = transcript.scrollHeight
  }

  return { transcriptRef, onScroll, latestOffer, jumpToLatest, pinned }
}
