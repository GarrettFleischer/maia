import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AttachmentChips, attachmentAllowed } from '@/components/shell/AttachmentChips'
import { MarkdownMessage } from '@/components/shell/MarkdownMessage'
import type {
  ActivityLine,
  ComposerNotice,
  OutgoingMessage,
  RouterMessage,
  TranscriptState,
} from '@/api/superAgentTypes'
import { composerStatusText } from '@/api/superAgentFormat'
import { composerFieldPx } from '@/components/shell/composerField'
import { useTranscriptPosition } from '@/components/shell/transcriptPosition'
import {
  dedupeRouterMessages,
  type AdmissionState,
  type RouterAnnouncement,
} from '@/state/superAgentSession'

function latestActivity(lines: readonly ActivityLine[]): ActivityLine[] {
  const router = lines.filter((line) => line.task_id === undefined).slice(-1)
  const tasks = new Map<string, ActivityLine>()
  for (const line of lines) {
    if (line.task_id) tasks.set(line.task_id, line)
  }
  return [...router, ...tasks.values()]
}

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
  submitOnEnter = true,
  onDraftChange,
  onRetryTranscript,
  onAnnouncementAcknowledged,
  onSubmit,
  factsUsed,
  onInspectFacts,
  canAttach = false,
  stageAttachments,
  outgoing = [],
  onRetryOutgoing,
  activity = [],
  onStopTask,
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
  submitOnEnter?: boolean
  onDraftChange: (draft: string) => void
  onRetryTranscript: () => void
  onAnnouncementAcknowledged: (sequence: number) => void
  onSubmit: () => void
  factsUsed?: ReadonlyMap<string, readonly string[]>
  onInspectFacts?: (messageId: string, ids: readonly string[]) => void
  canAttach?: boolean
  stageAttachments?: (files: readonly File[]) => Promise<void>
  outgoing?: readonly OutgoingMessage[]
  onRetryOutgoing?: (id: string) => void
  activity?: readonly ActivityLine[]
  onStopTask?: (taskId: string) => void
}) {
  const [rejection, setRejection] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [composerKey, setComposerKey] = useState(0)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const previousComposer = useRef({
    draft,
    sending: operation.kind === 'sending',
  })
  if (
    previousComposer.current.sending &&
    previousComposer.current.draft.length > 0 &&
    draft.length === 0
  ) {
    setComposerKey((key) => key + 1)
  }
  previousComposer.current = {
    draft,
    sending: operation.kind === 'sending',
  }
  const busy = disabled || admission.kind === 'blocked'
  const status = composerStatusText(notice, rejection)
  const [clock, setClock] = useState(() => Date.now())
  const activityStarted = useRef(new Map<string, number>())
  useEffect(() => {
    if (activity.length === 0) return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activity.length])
  const activityCards = latestActivity(activity)
  const visibleMessages = dedupeRouterMessages(messages)
  const messageKey = JSON.stringify(visibleMessages.map((message) => message.message_id))
  const { transcriptRef, onScroll, latestOffer, jumpToLatest } = useTranscriptPosition(
    messageKey,
    transcriptState,
  )
  const fitField = (field: HTMLTextAreaElement) => {
    field.style.height = 'auto'
    field.style.height = `${composerFieldPx(field.scrollHeight)}px`
  }
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (!field) return
    if (draft.length === 0) {
      field.style.height = ''
      return
    }
    fitField(field)
  }, [draft])

  useEffect(() => {
    if (!announcement) return
    const timeout = window.setTimeout(
      () => onAnnouncementAcknowledged(announcement.sequence),
      1_000,
    )
    return () => window.clearTimeout(timeout)
  }, [announcement, onAnnouncementAcknowledged])

  const addFiles = (list: FileList | null) => {
    if (!list) return
    const next: File[] = []
    for (const file of list) {
      if (!attachmentAllowed(file.type, file.size)) {
        setRejection('That file type is not allowed, or it is larger than 10 MB.')
        continue
      }
      next.push(file)
    }
    if (next.length > 0) setPendingFiles((current) => [...current, ...next])
  }

  const submit = async () => {
    if (busy) return
    if (draft.trim().length === 0) {
      setRejection('Write a message before sending.')
      return
    }
    setRejection(null)
    try {
      if (pendingFiles.length > 0) {
        await stageAttachments?.(pendingFiles)
        setPendingFiles([])
      }
      onSubmit()
    } catch {
      setRejection('The attachment could not be stored.')
    }
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
        {transcriptState.kind === 'empty' ? (
          <p>This is the owner chat. Say what you want done; work shows under Tasks.</p>
        ) : null}
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
                    <p className="maia-speaker">{speaker}</p>
                    {message.route ? (
                      <details className="maia-fold">
                        <summary>{routeSummary(message.route)}</summary>
                        <p className="maia-fold-body">{routeDetail(message.route)}</p>
                      </details>
                    ) : null}
                    <MarkdownMessage text={message.text} className="maia-transcript-body" />
                    <AttachmentChips chips={message.attachments ?? []} />
                    <FactsUsed
                      ids={factsUsed?.get(message.message_id) ?? []}
                      onOpen={() =>
                        onInspectFacts?.(
                          message.message_id,
                          factsUsed?.get(message.message_id) ?? [],
                        )
                      }
                    />
                  </article>
                </div>
              </li>
            )
          })}
          {outgoing.map((item) => (
            <li key={item.id}>
              <article className="maia-run maia-run--you" aria-label="Message from You">
                <p className="maia-speaker">You</p>
                <p className="maia-transcript-body">{item.text}</p>
                <p>{item.state === 'pending' ? 'Sending.' : 'Not sent.'}</p>
                {item.state === 'failed' ? (
                  <button type="button" className="maia-btn" onClick={() => onRetryOutgoing?.(item.id)}>
                    Retry
                  </button>
                ) : null}
              </article>
            </li>
          ))}
        </ol>
      </div>
      {activityCards.length > 0 ? (
        <ul className="maia-activity" aria-label="Working">
          {activityCards.map((line) => {
            const key = line.task_id ?? `router-${line.seq}`
            if (!activityStarted.current.has(key)) activityStarted.current.set(key, clock)
            const elapsed = Math.max(
              0,
              Math.floor((clock - (activityStarted.current.get(key) ?? clock)) / 1000),
            )
            return (
              <li key={key}>
                <p role="status">
                  {line.label}
                  {elapsed > 0 ? ` · ${elapsed}s` : ''}
                </p>
                {line.task_id ? (
                  <button
                    type="button"
                    className="maia-btn"
                    onClick={() => onStopTask?.(line.task_id ?? '')}
                  >
                    Stop {line.task_id}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {latestOffer ? (
        <button type="button" className="maia-btn maia-latest" onClick={jumpToLatest}>
          New messages
        </button>
      ) : null}
      {accessory}
      <form
        className="maia-composer"
        data-testid="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        onDragOver={(event) => {
          if (!canAttach) return
          event.preventDefault()
        }}
        onDrop={(event) => {
          if (!canAttach) return
          event.preventDefault()
          addFiles(event.dataTransfer.files)
        }}
        onPaste={(event) => {
          if (!canAttach || event.clipboardData.files.length === 0) return
          addFiles(event.clipboardData.files)
        }}
      >
        <div className="maia-composer-box">
        {pendingFiles.length > 0 ? (
          <ul className="maia-attachment-chips" aria-label="Attachments">
            {pendingFiles.map((file) => (
              <li key={`${file.name}-${file.size}-${file.lastModified}`}>
                <span>{file.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setPendingFiles((current) => current.filter((item) => item !== file))
                  }
                >
                  Remove {file.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label htmlFor="composer-input" className="visually-hidden">
          Message
        </label>
        <textarea
          ref={fieldRef}
          key={composerKey}
          id="composer-input"
          placeholder="Message Router"
          value={draft}
          disabled={busy}
          aria-disabled={busy}
          aria-invalid={rejection ? true : undefined}
          onChange={(event) => {
            fitField(event.currentTarget)
            setRejection(null)
            onDraftChange(event.target.value)
          }}
          onKeyDown={(event) => {
            if (!submitOnEnter) return
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <div className="maia-composer-row">
          {submitOnEnter ? (
            <span className="maia-composer-hint">
              <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
            </span>
          ) : (
            <span className="maia-composer-hint" />
          )}
          {canAttach ? (
            <label className="maia-btn">
              Attach
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,text/plain,application/pdf"
                multiple
                hidden
                onChange={(event) => {
                  addFiles(event.currentTarget.files)
                  event.currentTarget.value = ''
                }}
              />
            </label>
          ) : null}
          <button type="submit" className="maia-btn maia-btn--primary" disabled={busy}>
            Send
          </button>
        </div>
        </div>
        {status ? (
          <div className="maia-status-row">
            <p
              className={
                notice.kind === 'failed' || notice.kind === 'admitted_failure'
                  ? 'maia-status maia-status--failed'
                  : 'maia-status'
              }
              role="status"
            >
              {status}
            </p>
            {notice.kind === 'quiet' ? (
              <button
                type="button"
                className="maia-btn"
                onClick={() => {
                  const pending = outgoing.find((item) => item.state === 'pending')
                  if (pending) onRetryOutgoing?.(pending.id)
                }}
              >
                Retry
              </button>
            ) : null}
            {notice.kind === 'refresh_failed' ? (
              <button
                type="button"
                className="maia-btn"
                onClick={onRetryTranscript}
                disabled={operation.kind === 'sending'}
              >
                Refresh conversation
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
    </>
  )
}

function FactsUsed({ ids, onOpen }: { ids: readonly string[]; onOpen: () => void }) {
  if (ids.length === 0) return null
  return (
    <button type="button" className="maia-btn" onClick={onOpen}>
      Facts used
    </button>
  )
}
