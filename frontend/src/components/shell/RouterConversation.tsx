import { useEffect, useState, type ReactNode } from 'react'
import { MarkdownMessage } from '@/components/shell/MarkdownMessage'
import type { ComposerNotice, RouterMessage, TranscriptState } from '@/api/superAgentTypes'
import { composerStatusText } from '@/api/superAgentFormat'
import { useTranscriptPosition } from '@/components/shell/transcriptPosition'
import {
  dedupeRouterMessages,
  type AdmissionState,
  type RouterAnnouncement,
} from '@/state/superAgentSession'

function routeSummary(route: string): string {
  if (route === 'relay_report') return 'Relay · task report'
  return 'Route · admitted by host'
}

function routeDetail(route: string): string {
  if (route === 'spawn_task') return 'The host admitted one parent task.'
  if (route === 'continue_task') return 'The host handed this message to the task.'
  if (route === 'relay_report') return 'Untrusted task report, relayed as text.'
  return 'The host admitted the route.'
}

export function RouterConversation({
  messages,
  transcriptState,
  admittedStatusMessageId = null,
  admission,
  operation,
  announcement,
  draft,
  notice,
  disabled,
  accessory = null,
  onDraftChange,
  onRetryTranscript,
  onAnnouncementAcknowledged,
  onSubmit,
}: {
  messages: readonly RouterMessage[]
  transcriptState: TranscriptState
  admittedStatusMessageId?: string | null
  admission: AdmissionState
  operation: { kind: 'idle' } | { kind: 'sending' }
  announcement: RouterAnnouncement | null
  draft: string
  notice: ComposerNotice
  disabled: boolean
  accessory?: ReactNode
  onDraftChange: (draft: string) => void
  onRetryTranscript: () => void
  onAnnouncementAcknowledged: (sequence: number) => void
  onSubmit: () => void
}) {
  const [rejection, setRejection] = useState<string | null>(null)
  const busy = disabled || admission.kind === 'blocked' || operation.kind === 'sending'
  const status =
    operation.kind === 'sending' ? 'Sending.' : composerStatusText(notice, rejection)
  const visibleMessages = dedupeRouterMessages(messages)
  const messageKey = JSON.stringify(visibleMessages.map((message) => message.message_id))
  const { transcriptRef, onScroll } = useTranscriptPosition(messageKey, transcriptState)

  useEffect(() => {
    if (!announcement) return
    const timeout = window.setTimeout(
      () => onAnnouncementAcknowledged(announcement.sequence),
      1_000,
    )
    return () => window.clearTimeout(timeout)
  }, [announcement, onAnnouncementAcknowledged])

  const submit = () => {
    if (busy) return
    if (draft.trim().length === 0) {
      setRejection('Write a message before sending.')
      return
    }
    setRejection(null)
    onSubmit()
  }

  return (
    <>
      <div
        className="visually-hidden"
        data-testid="transcript-announcer"
        aria-live="polite"
        aria-atomic="true"
        aria-relevant="additions"
      >
        {announcement ? (
          <span
            key={announcement.sequence}
            data-announcement-sequence={announcement.sequence}
          >
            {announcement.text}
          </span>
        ) : null}
      </div>
      <div
        ref={transcriptRef}
        className="maia-transcript"
        data-testid="transcript"
        role="log"
        aria-label="Router transcript"
        aria-live="off"
        aria-relevant="additions text"
        aria-busy={transcriptState.kind === 'loading'}
        onScroll={onScroll}
      >
        {transcriptState.kind === 'loading' ? (
          <p role="status">
            {visibleMessages.length === 0 ? 'Loading conversation.' : 'Refreshing conversation.'}
          </p>
        ) : null}
        {transcriptState.kind === 'empty' ? <p>No messages yet.</p> : null}
        {transcriptState.kind === 'error' ? (
          <div role={notice.kind === 'admitted_failure' ? undefined : 'status'}>
            <p>{transcriptState.text}</p>
            <button
              type="button"
              className="maia-btn"
              onClick={onRetryTranscript}
              disabled={operation.kind === 'sending'}
            >
              Retry conversation
            </button>
          </div>
        ) : null}
        <ol className="maia-transcript-list" aria-label="Transcript messages">
          {visibleMessages.map((message) => {
            const speaker = message.role === 'owner' ? 'You' : 'Router'
            return (
              <li key={message.message_id}>
                <div role={message.message_id === admittedStatusMessageId ? 'status' : undefined}>
                  <article
                    className={message.role === 'owner' ? 'maia-run maia-run--you' : 'maia-run'}
                    aria-label={`Message from ${speaker}`}
                  >
                    {message.thinking ? (
                      <details className="maia-fold">
                        <summary>Thinking</summary>
                        <MarkdownMessage text={message.thinking} className="maia-fold-body" />
                      </details>
                    ) : null}
                    {message.route ? (
                      <details className="maia-fold">
                        <summary>{routeSummary(message.route)}</summary>
                        <p className="maia-fold-body">{routeDetail(message.route)}</p>
                      </details>
                    ) : null}
                    <MarkdownMessage text={message.text} className="maia-transcript-body" />
                  </article>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
      {accessory}
      <form
        className="maia-composer"
        data-testid="composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="maia-composer-box">
        <label htmlFor="composer-input" className="visually-hidden">
          Message
        </label>
        <textarea
          id="composer-input"
          placeholder="Message Router"
          value={draft}
          disabled={busy}
          aria-disabled={busy}
          aria-invalid={rejection ? true : undefined}
          onChange={(event) => {
            setRejection(null)
            onDraftChange(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="maia-composer-row">
          <span className="maia-composer-hint">
            <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
          </span>
          <button type="submit" className="maia-btn maia-btn--primary" disabled={busy}>
            Send
          </button>
        </div>
        </div>
        {status ? (
          <p
            className={
              notice.kind === 'failed' ||
              notice.kind === 'admitted_failure' ||
              notice.kind === 'refresh_failed'
                ? 'maia-status maia-status--failed'
                : 'maia-status'
            }
            role="status"
          >
            {status}
          </p>
        ) : null}
      </form>
    </>
  )
}
