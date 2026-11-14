import { useEffect, useId, useRef } from 'react'
import type { PinMark, TaskDetail as TaskDetailData, TaskPhaseName } from '@/api/superAgentTypes'
import {
  canCancelTask,
  canRetryTask,
  shownAcceptanceContext,
  textOrNone,
  visibleInspectionGroups,
  type InspectionListItem,
} from '@/api/superAgentFormat'

function RecordList({ label, items }: { label: string; items: readonly InspectionListItem[] }) {
  const headingId = useId()
  return (
    <div>
      <h3 id={headingId}>{label}</h3>
      {items.length === 0 ? (
        <p>None recorded.</p>
      ) : (
        <ul aria-labelledby={headingId}>
          {items.map((item) => (
            <li key={item.id}>{item.text}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function TaskDetail({
  detail,
  pin,
  phase = null,
  operation,
  onClose,
  onQuote,
  onPin,
  onCancel,
  onRetry,
}: {
  detail: TaskDetailData
  pin: PinMark
  phase?: TaskPhaseName | null
  operation: { kind: 'idle' } | { kind: 'sending' }
  onClose: () => void
  onQuote: (taskId: string) => void
  onPin: (taskId: string, pin: PinMark) => void
  onCancel?: (taskId: string) => void
  onRetry?: (taskId: string) => void
}) {
  const nextPin: PinMark = pin === 'pinned' ? 'unpinned' : 'pinned'
  const showCancel = phase != null && onCancel != null && canCancelTask(phase)
  const showRetry = phase != null && onRetry != null && canRetryTask(phase)
  const backRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    backRef.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    window.history.pushState({ maiaOverlay: detail.task_id }, '')
    const onPop = () => onCloseRef.current()
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('popstate', onPop)
      const marker = window.history.state as { maiaOverlay?: string } | null
      if (marker?.maiaOverlay === detail.task_id) window.history.back()
    }
  }, [detail.task_id])
  const closeStyle = { minHeight: 44, minWidth: 44 }
  const acceptance = shownAcceptanceContext(detail.acceptance_context)
  return (
      <article className="maia-task-detail" aria-label="Task conversation">
        <div className="maia-task-detail-bar">
          <h2 id="task-detail-title">{detail.title}</h2>
          <div className="maia-task-detail-close">
            <button ref={backRef} type="button" className="maia-btn" style={closeStyle} onClick={onClose}>
              Back to chat
            </button>
            <button type="button" className="maia-btn" style={closeStyle} aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>
        <div className="maia-task-detail-body">
          {detail.todos && detail.todos.length > 0 ? (
            <>
              <h3>Working list</h3>
              <ul aria-label="Working list">
                {detail.todos.map((item) => (
                  <li key={item.id}>
                    {item.status === 'done' ? '☑' : item.status === 'in_progress' ? '…' : '☐'} {item.text}
                    {item.note ? ` — ${item.note}` : ''}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h3>Original prompt</h3>
          <p>{textOrNone(detail.original_prompt)}</p>
          {acceptance ? (
            <>
              <h3>Acceptance context</h3>
              <p>{acceptance}</p>
            </>
          ) : null}
          {visibleInspectionGroups(detail).map((group) => (
            <RecordList key={group.label} label={group.label} items={group.items} />
          ))}
          <div className="maia-task-actions">
            <button
              type="button"
              className="maia-btn"
              disabled={operation.kind === 'sending'}
              onClick={() => onQuote(detail.task_id)}
            >
              Quote task
            </button>
            <button type="button" className="maia-btn" onClick={() => onPin(detail.task_id, nextPin)}>
              {pin === 'pinned' ? 'Unpin this task' : 'Pin this task'}
            </button>
            {showRetry ? (
              <button
                type="button"
                className="maia-btn"
                disabled={operation.kind === 'sending'}
                onClick={() => onRetry(detail.task_id)}
              >
                Retry task
              </button>
            ) : null}
            {showCancel ? (
              <button
                type="button"
                className="maia-btn"
                disabled={operation.kind === 'sending'}
                onClick={() => onCancel(detail.task_id)}
              >
                Cancel task
              </button>
            ) : null}
          </div>
        </div>
      </article>
  )
}
