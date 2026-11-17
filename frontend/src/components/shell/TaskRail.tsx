import { useState, type ReactNode } from 'react'
import type { PinMark, SidebarRow, SidebarSection, TaskPhaseName } from '@/api/superAgentTypes'
import {
  ACTIVITY_PREVIEW_LIMIT,
  SIDEBAR_SECTION_ORDER,
  activityPreview,
  formatPhase,
  taskCardMeta,
  groupSidebarRows,
} from '@/api/superAgentFormat'

function phaseMark(phase: TaskPhaseName): string {
  if (phase === 'running') return 'maia-mark maia-mark--run'
  if (phase === 'completed') return 'maia-mark maia-mark--done'
  if (phase === 'queued') return 'maia-mark maia-mark--wait'
  if (phase === 'cancelled' || phase === 'abandoned') return 'maia-mark maia-mark--arch'
  return 'maia-mark maia-mark--need'
}

function ActivityPreview({ summary }: { summary: string }) {
  const preview = activityPreview(summary, ACTIVITY_PREVIEW_LIMIT)
  if (preview.length === 0) return null
  return <span className="maia-task-sum">{preview}</span>
}

function ArchiveDisclosure({
  count,
  startOpen,
  children,
}: {
  count: number
  startOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(startOpen)
  return (
    <details open={open} aria-label="Archive">
      <summary
        onClick={(event) => {
          event.preventDefault()
          setOpen((current) => !current)
        }}
      >
        {`Archive (${count})`}
      </summary>
      {children}
    </details>
  )
}

function TaskBranch({
  row,
  depth,
  expanded,
  openTaskId,
  onToggle,
  onOpen,
  onPin,
}: {
  row: SidebarRow
  depth: number
  expanded: ReadonlySet<string>
  openTaskId: string | null
  onToggle: (taskId: string) => void
  onOpen: (taskId: string) => void
  onPin: (taskId: string, pin: PinMark) => void
}) {
  const expandedRow = expanded.has(row.task_id)
  const selected = openTaskId === row.task_id
  const meta = taskCardMeta(row.phase, row.elapsed_ms)
  const pinLabel = row.section === 'pinned' ? 'Unpin' : 'Pin'
  const nextPin: PinMark = row.section === 'pinned' ? 'unpinned' : 'pinned'
  return (
    <li
      aria-label={row.title}
      aria-current={selected ? 'true' : undefined}
      className={selected ? 'maia-task-row maia-task-row--selected' : 'maia-task-row'}
    >
      <div className="maia-task-head">
        {row.children.length > 0 ? (
          <button
            type="button"
            className="maia-chev"
            aria-expanded={expandedRow}
            aria-label={`${expandedRow ? 'Collapse' : 'Expand'} ${row.title}`}
            title={expandedRow ? 'Hide helpers' : 'Show helpers'}
            onClick={() => onToggle(row.task_id)}
          >
            <span className="maia-chev-icon" aria-hidden="true" />
          </button>
        ) : (
          <span className="maia-chev-spacer" aria-hidden="true" />
        )}
        <button
          type="button"
          className="maia-task-open"
          aria-label={`Open ${row.title}`}
          onClick={() => onOpen(row.task_id)}
        >
          <span className="maia-task-title">{row.title}</span>
          <span className="maia-task-phase" title={formatPhase(row.phase)}>
            <span className={phaseMark(row.phase)} aria-hidden="true" />
            <span className="visually-hidden">{formatPhase(row.phase)}</span>
          </span>
          <ActivityPreview summary={row.summary} />
          {meta.length > 0 ? <span className="maia-task-meta">{meta}</span> : null}
        </button>
        {depth === 0 ? (
          <button
            type="button"
            className="maia-pin"
            aria-pressed={row.section === 'pinned'}
            aria-label={`${pinLabel} ${row.title}`}
            title={pinLabel}
            onClick={() => onPin(row.task_id, nextPin)}
          >
            <span className="maia-pin-icon" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {row.children.length > 0 && expandedRow ? (
        <ul className="maia-task-tree" data-level={String(depth + 1)} aria-label={`Helpers for ${row.title}`}>
          {row.children.map((child) => (
            <TaskBranch
              key={child.task_id}
              row={child}
              depth={depth + 1}
              expanded={expanded}
              openTaskId={openTaskId}
              onToggle={onToggle}
              onOpen={onOpen}
              onPin={onPin}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function SidebarSectionBlock({
  label,
  section,
  rows,
  expanded,
  openTaskId,
  onToggle,
  onOpen,
  onPin,
  empty,
  archiveOpen,
}: {
  label: string
  section: SidebarSection
  rows: readonly SidebarRow[]
  expanded: ReadonlySet<string>
  openTaskId: string | null
  onToggle: (taskId: string) => void
  onOpen: (taskId: string) => void
  onPin: (taskId: string, pin: PinMark) => void
  empty: 'hidden' | 'shown'
  archiveOpen: boolean
}) {
  if (rows.length === 0) {
    if (empty === 'hidden' || (section !== 'needs_you' && section !== 'working')) return null
    const emptyCopy = section === 'needs_you' ? 'None waiting' : 'Nothing queued'
    return (
      <section aria-label={label} className="maia-task-section">
        <h2 className="maia-task-heading">
          {label}
          <span className="maia-count">0</span>
        </h2>
        <p className="maia-task-empty">{emptyCopy}</p>
      </section>
    )
  }
  const list = (
    <ul className="maia-task-tree" data-level="root">
      {rows.map((row) => (
        <TaskBranch
          key={row.task_id}
          row={row}
          depth={0}
          expanded={expanded}
          openTaskId={openTaskId}
          onToggle={onToggle}
          onOpen={onOpen}
          onPin={onPin}
        />
      ))}
    </ul>
  )
  if (section === 'archive') {
    return (
      <section aria-label={label} className="maia-task-section">
        <ArchiveDisclosure count={rows.length} startOpen={archiveOpen}>{list}</ArchiveDisclosure>
      </section>
    )
  }
  return (
    <section aria-label={label} className="maia-task-section">
      <h2 className="maia-task-heading">
        {label}
        <span className="maia-count">{rows.length}</span>
      </h2>
      {list}
    </section>
  )
}

export function TaskRail({
  rows,
  openTaskId = null,
  onOpen,
  onPin = () => undefined,
  archiveOpen = false,
}: {
  rows: readonly SidebarRow[]
  openTaskId?: string | null
  onOpen: (taskId: string) => void
  onPin?: (taskId: string, pin: PinMark) => void
  archiveOpen?: boolean
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const grouped = groupSidebarRows(rows)
  const onToggle = (taskId: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  return (
    <div className="maia-task-rail">
      {SIDEBAR_SECTION_ORDER.map((entry) => (
        <SidebarSectionBlock
          key={entry.section}
          label={entry.label}
          section={entry.section}
          rows={grouped.get(entry.section) ?? []}
          expanded={expanded}
          openTaskId={openTaskId}
          onToggle={onToggle}
          onOpen={onOpen}
          onPin={onPin}
          empty={rows.length === 0 ? 'shown' : 'hidden'}
          archiveOpen={archiveOpen}
        />
      ))}
    </div>
  )
}
