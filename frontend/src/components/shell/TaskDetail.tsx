import { useEffect, useId, useRef } from 'react'
import type { PinMark, TaskDetail as TaskDetailData } from '@/api/superAgentTypes'
import {
  shownAcceptanceContext,
  inspectionGroups,
  textOrNone,
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
  operation,
  onClose,
  onQuote,
  onPin,
}: {
  detail: TaskDetailData
  pin: PinMark
  operation: { kind: 'idle' } | { kind: 'sending' }
  onClose: () => void
  onQuote: (taskId: string) => void
  onPin: (taskId: string, pin: PinMark) => void
}) {
  const nextPin: PinMark = pin === 'pinned' ? 'unpinned' : 'pinned'
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
          {inspectionGroups(detail)
            .filter((group) => group.items.length > 0)
            .map((group) => (
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
          </div>
        </div>
      </article>
  )
}
