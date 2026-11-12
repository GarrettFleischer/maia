import type {
  ComposerNotice,
  CriterionMarkName,
  PinMark,
  SidebarRow,
  SidebarSection,
  TaskDetail,
  TaskPhaseName,
} from '@/api/superAgentTypes'

export const SIDEBAR_SECTION_ORDER: readonly { section: SidebarSection; label: string }[] = [
  { section: 'needs_you', label: 'Needs you' },
  { section: 'working', label: 'Working' },
  { section: 'completed', label: 'Completed' },
  { section: 'pinned', label: 'Pinned' },
  { section: 'archive', label: 'Archive' },
]

const PHASE_LABELS: Record<TaskPhaseName, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_for_user: 'Waiting for you',
  blocked: 'Blocked',
  failed: 'Failed',
  completed: 'Completed',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
  abandoned: 'Abandoned',
}

const CRITERION_MARK_LABELS: Record<CriterionMarkName, string> = {
  pending: 'Pending',
  satisfied: 'Satisfied',
  waived: 'Waived',
  inapplicable: 'Inapplicable',
}

const TERMINAL_PHASES: ReadonlySet<TaskPhaseName> = new Set(['completed', 'cancelled', 'abandoned'])

export const ACTIVITY_PREVIEW_LIMIT = 80

export function activityPreview(summary: string, limit: number): string {
  const flat = summary.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  if (chars.length <= limit) return flat
  const kept = chars.slice(0, Math.max(limit, 0)).join('').trimEnd()
  return kept.length === 0 ? '…' : `${kept}…`
}

export interface InspectionListItem {
  id: string
  text: string
}

export interface InspectionGroup {
  label: string
  items: InspectionListItem[]
}

export function groupSidebarRows(rows: readonly SidebarRow[]): Map<SidebarSection, SidebarRow[]> {
  const grouped = new Map<SidebarSection, SidebarRow[]>()
  for (const entry of SIDEBAR_SECTION_ORDER) {
    grouped.set(entry.section, [])
  }
  for (const row of rows) {
    grouped.get(row.section)?.push(row)
  }
  return grouped
}

export function findSidebarRow(rows: readonly SidebarRow[], taskId: string): SidebarRow | null {
  for (const row of rows) {
    if (row.task_id === taskId) return row
    const child = findSidebarRow(row.children, taskId)
    if (child) return child
  }
  return null
}

export function pinMarkFor(rows: readonly SidebarRow[], taskId: string): PinMark {
  return findSidebarRow(rows, taskId)?.section === 'pinned' ? 'pinned' : 'unpinned'
}

export function isNonTerminalPhase(phase: TaskPhaseName): boolean {
  return !TERMINAL_PHASES.has(phase)
}

export function countActivity(rows: readonly SidebarRow[]): { running: number; needsYou: number } {
  return {
    running: rows.reduce((total, row) => total + countRunningThreads(row), 0),
    needsYou: rows.filter((row) => row.section === 'needs_you').length,
  }
}

export function phoneStopLabel(counts: { running: number; needsYou: number }): string | null {
  if (counts.running <= 0 && counts.needsYou <= 0) return null
  if (counts.running > 0 && counts.needsYou > 0) {
    return `${counts.running} running · ${counts.needsYou} needs you`
  }
  if (counts.running > 0) return `${counts.running} running`
  return `${counts.needsYou} needs you`
}

function countRunningThreads(row: SidebarRow): number {
  const own = row.phase === 'running' ? 1 : 0
  return own + row.children.reduce((total, child) => total + countRunningThreads(child), 0)
}

export function formatPhase(phase: TaskPhaseName): string {
  return PHASE_LABELS[phase]
}

export function formatCriterionMark(mark: CriterionMarkName): string {
  return CRITERION_MARK_LABELS[mark]
}

export function formatElapsed(elapsedMs: number): string {
  const safe = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.floor(elapsedMs) : 0
  if (safe < 1000) return `${safe} ms`
  const totalSeconds = Math.floor(safe / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function appendReference(draft: string, insert: string): string {
  if (draft.length === 0) return insert
  if (/\s$/.test(draft)) return `${draft}${insert}`
  return `${draft} ${insert}`
}

export function textOrNone(value: string): string {
  return value.trim().length === 0 ? 'None recorded.' : value
}

export function composerStatusText(notice: ComposerNotice, rejection: string | null): string | null {
  if (notice.kind === 'pending') return 'Sending.'
  if (notice.kind === 'quiet') return notice.text
  if (
    notice.kind === 'failed' ||
    notice.kind === 'admitted_failure' ||
    notice.kind === 'refresh_failed'
  ) {
    return notice.text
  }
  return rejection
}

export function inspectionGroups(detail: TaskDetail): InspectionGroup[] {
  return [
    {
      label: 'Transcript',
      items: detail.transcript.map((line) => ({
        id: line.id,
        text: `${line.author}: ${line.text}`,
      })),
    },
    {
      label: 'Tool events',
      items: detail.tool_events.map((event) => ({
        id: event.call_id,
        text: `${event.name} · ${event.summary}`,
      })),
    },
    {
      label: 'Artifacts',
      items: detail.artifacts.map((artifact) => ({
        id: artifact.artifact_id,
        text: artifact.label,
      })),
    },
    {
      label: 'Attempts',
      items: detail.attempts.map((attempt) => ({
        id: attempt.attempt_id,
        text: `${formatPhase(attempt.phase)} · ${attempt.summary}`,
      })),
    },
    {
      label: 'Decisions',
      items: detail.decisions.map((decision) => ({
        id: decision.decision_id,
        text: decision.text,
      })),
    },
    {
      label: 'Criteria',
      items: detail.criteria.map((criterion) => ({
        id: criterion.criterion_id,
        text: `${criterion.text} · ${formatCriterionMark(criterion.mark)}`,
      })),
    },
    {
      label: 'Helpers',
      items: detail.helpers.map((helper) => ({
        id: helper.task_id,
        text: helper.title,
      })),
    },
  ]
}
