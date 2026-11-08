import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SidebarRow } from '@/api/superAgentTypes'
import { AgentRail } from '@/components/shell/AgentRail'
import { renderWithMaia } from '@/test/renderWithMaia'

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

describe('AgentRail activity in live mode', () => {
  it('shows running and needs-you counts from the sidebar rows, helpers included', () => {
    const rows = [
      row({
        task_id: 'parent-a',
        section: 'working',
        phase: 'running',
        children: [row({ task_id: 'helper-running', section: 'working', phase: 'running' })],
      }),
      row({ task_id: 'parent-b', section: 'needs_you', phase: 'waiting_for_user' }),
    ]

    renderWithMaia(
      <AgentRail
        dataSource="live"
        rows={rows}
        onOpen={vi.fn()}
        onPin={vi.fn()}
        onOpenBrain={vi.fn()}
        brainActive={false}
        onOpenSettings={vi.fn()}
        settingsActive={false}
        onStopAll={vi.fn()}
      />,
    )

    expect(screen.getByTestId('activity-counts')).toHaveTextContent('2 running · 1 needs you')
  })
})
