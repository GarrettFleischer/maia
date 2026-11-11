import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_PREVIEW_LIMIT,
  activityPreview,
  countActivity,
  formatPhase,
  phoneStopLabel,
  isNonTerminalPhase,
} from '@/api/superAgentFormat'
import type { SidebarRow } from '@/api/superAgentTypes'

function row(overrides: Partial<SidebarRow> & Pick<SidebarRow, 'task_id' | 'section' | 'phase'>): SidebarRow {
  return {
    title: overrides.task_id,
    summary: 'Update',
    elapsed_ms: 1000,
    criteria_done: 0,
    criteria_total: 1,
    children: [],
    ...overrides,
  }
}

describe('countActivity', () => {
  it('counts running threads including helpers, and top-level needs-you tasks only', () => {
    const rows = [
      row({
        task_id: 'parent-a',
        section: 'working',
        phase: 'running',
        children: [
          row({ task_id: 'helper-queued', section: 'working', phase: 'queued' }),
          row({ task_id: 'helper-done', section: 'completed', phase: 'completed' }),
        ],
      }),
      row({
        task_id: 'parent-b',
        section: 'needs_you',
        phase: 'waiting_for_user',
        children: [row({ task_id: 'helper-running', section: 'working', phase: 'running' })],
      }),
      row({ task_id: 'parent-c', section: 'archive', phase: 'cancelled' }),
    ]

    expect(countActivity(rows)).toEqual({ running: 2, needsYou: 1 })
  })

  it('reports zero for an empty sidebar', () => {
    expect(countActivity([])).toEqual({ running: 0, needsYou: 0 })
    expect(phoneStopLabel(countActivity([]))).toBeNull()
  })

  it('names running work and waiting needs-you work for the phone stop bar', () => {
    expect(phoneStopLabel({ running: 2, needsYou: 0 })).toBe('2 running')
    expect(phoneStopLabel({ running: 0, needsYou: 1 })).toBe('1 needs you')
    expect(phoneStopLabel(countActivity([
      row({ task_id: 'wait', section: 'needs_you', phase: 'waiting_for_user' }),
    ]))).toBe('1 needs you')
  })

  it('labels a stopped phase as Stopped and keeps it resumable', () => {
    expect(formatPhase('stopped')).toBe('Stopped')
    expect(isNonTerminalPhase('stopped')).toBe(true)
  })
})

describe('activityPreview', () => {
  it('keeps a short latest activity and caps a long one to one line', () => {
    expect(activityPreview('Ready to review', ACTIVITY_PREVIEW_LIMIT)).toBe('Ready to review')
    const weather = `Here's the current weather for Canby.\n${'Rain likely. '.repeat(30)}`
    const preview = activityPreview(weather, ACTIVITY_PREVIEW_LIMIT)
    expect(preview.startsWith("Here's the current weather for Canby.")).toBe(true)
    expect(preview.endsWith('…')).toBe(true)
    expect([...preview].length).toBe(ACTIVITY_PREVIEW_LIMIT + 1)
    expect(preview).not.toContain('\n')
    expect(preview).not.toContain(weather)
  })
})
