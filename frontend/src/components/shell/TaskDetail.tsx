import { useId } from 'react'
import type { PinMark, TaskDetail as TaskDetailData } from '@/api/superAgentTypes'
import { inspectionGroups, textOrNone, type InspectionListItem } from '@/api/superAgentFormat'
import { FocusTrap } from '@/components/a11y/FocusTrap'

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
  return (
    <FocusTrap active onClose={onClose} labelId="task-detail-title" layer="above">
      <div className="maia-task-detail">
        <h2 id="task-detail-title">Task detail</h2>
        <p>Read only. Sending stays in the router conversation.</p>
        <h3>Original prompt</h3>
        <p>{textOrNone(detail.original_prompt)}</p>
        <h3>Acceptance context</h3>
        <p>{textOrNone(detail.acceptance_context)}</p>
        {inspectionGroups(detail).map((group) => (
          <RecordList key={group.label} label={group.label} items={group.items} />
        ))}
        <div className="maia-task-actions">
          <button type="button" className="maia-btn" onClick={onClose}>
            Close detail
          </button>
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
    </FocusTrap>
  )
}
