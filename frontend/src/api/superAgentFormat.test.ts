import { describe, expect, it } from 'vitest'
import { countActivity, formatPhase, isNonTerminalPhase } from '@/api/superAgentFormat'
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
  })

  it('labels a stopped phase as Stopped and keeps it resumable', () => {
    expect(formatPhase('stopped')).toBe('Stopped')
    expect(isNonTerminalPhase('stopped')).toBe(true)
  })
})
