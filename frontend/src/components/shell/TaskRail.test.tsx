import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SidebarRow, TaskDetail as TaskDetailData } from '@/api/superAgentTypes'
import { TaskDetail } from '@/components/shell/TaskDetail'
import { TaskRail } from '@/components/shell/TaskRail'

const rows: SidebarRow[] = [
  {
    task_id: 'task-1',
    title: 'Pin control',
    section: 'completed',
    phase: 'completed',
    summary: 'Ready to review',
    elapsed_ms: 1200,
    criteria_done: 1,
    criteria_total: 1,
    children: [
      {
        task_id: 'child-1',
        title: 'Write the control',
        section: 'working',
        phase: 'running',
        summary: 'Editing',
        elapsed_ms: 400,
        criteria_done: 0,
        criteria_total: 1,
        children: [],
      },
    ],
  },
]

function row(overrides: Partial<SidebarRow> & Pick<SidebarRow, 'task_id' | 'title' | 'section' | 'phase'>): SidebarRow {
  return {
    summary: 'Update',
    elapsed_ms: 1000,
    criteria_done: 0,
    criteria_total: 1,
    children: [],
    ...overrides,
  }
}

const inspection: TaskDetailData = {
  task_id: 'task-1',
  title: 'Pin control',
  original_prompt: 'Add a pin control',
  acceptance_context: 'Pin moves the row and keeps the envelope.',
  transcript: [{ id: 'line-1', author: 'Parent', text: 'Editing the control.' }],
  tool_events: [{ call_id: 'call-1', name: 'edit', summary: 'Updated pin handler' }],
  artifacts: [{ artifact_id: 'art-1', label: 'pin-control.diff' }],
  attempts: [{ attempt_id: 'attempt-1', phase: 'completed', summary: 'Ready to review' }],
  decisions: [],
  criteria: [{ criterion_id: 'criterion-1', text: 'Pin control is visible', mark: 'satisfied' }],
  helpers: [{ task_id: 'child-1', title: 'Write the control' }],
}

describe('TaskRail', () => {
  it('shows a completed parent and nests the helper', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<TaskRail rows={rows} onOpen={onOpen} />)
    expect(screen.getByRole('region', { name: 'Completed' })).toHaveTextContent('Pin control')
    expect(screen.getByRole('region', { name: 'Completed' })).toHaveTextContent('1s')
    expect(screen.getByRole('region', { name: 'Completed' })).toHaveTextContent('1/1')
    expect(screen.queryByRole('listitem', { name: 'Write the control' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Expand Pin control' }))
    expect(screen.getByText('Write the control')).toBeInTheDocument()
    expect(screen.getByText(/400 ms/)).toBeInTheDocument()
    expect(
      screen.getAllByRole('listitem').filter((item) => item.parentElement?.getAttribute('data-level') === 'root'),
    ).toHaveLength(1)
  })

  it('orders populated sections and hides empty ones', () => {
    render(
      <TaskRail
        rows={[
          row({ task_id: 'needs', title: 'Needs row', section: 'needs_you', phase: 'failed' }),
          row({
            task_id: 'work',
            title: 'Working row',
            section: 'working',
            phase: 'running',
            elapsed_ms: 90000,
          }),
          row({ task_id: 'done', title: 'Completed row', section: 'completed', phase: 'completed' }),
          row({ task_id: 'pin', title: 'Pinned row', section: 'pinned', phase: 'completed' }),
          row({ task_id: 'old', title: 'Archived row', section: 'archive', phase: 'cancelled' }),
        ]}
        onOpen={vi.fn()}
      />,
    )
    const labels = ['Needs you', 'Working', 'Completed', 'Pinned', 'Archive']
    const regions = labels.map((label) => screen.getByRole('region', { name: label }))
    for (let index = 1; index < regions.length; index += 1) {
      const previous = regions[index - 1]
      const current = regions[index]
      if (!previous || !current) {
        throw new Error('missing section')
      }
      expect(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(screen.getByRole('region', { name: 'Working' })).toHaveTextContent('1m 30s')
    expect(screen.getByRole('region', { name: 'Working' })).not.toHaveTextContent('Write the control')
  })

  it('does not render empty sidebar sections when other tasks are listed', () => {
    render(<TaskRail rows={rows} onOpen={vi.fn()} />)
    expect(screen.queryByRole('region', { name: 'Needs you' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Working' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Pinned' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Archive' })).not.toBeInTheDocument()
  })

  it('shows Needs you and Working empty lines when the rail has no tasks', () => {
    render(<TaskRail rows={[]} onOpen={vi.fn()} />)
    expect(screen.getByRole('region', { name: 'Needs you' })).toHaveTextContent('None waiting')
    expect(screen.getByRole('region', { name: 'Working' })).toHaveTextContent('Nothing queued')
    expect(screen.queryByRole('region', { name: 'Pinned' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Archive' })).not.toBeInTheDocument()
  })

  it('keeps archive collapsed until its disclosure is opened', async () => {
    const user = userEvent.setup()
    render(
      <TaskRail
        rows={[row({ task_id: 'old', title: 'Archived row', section: 'archive', phase: 'cancelled' })]}
        onOpen={vi.fn()}
      />,
    )
    const archive = screen.getByRole('region', { name: 'Archive' })
    const disclosure = within(archive).getByRole('group', { name: 'Archive' })
    expect(disclosure).not.toHaveAttribute('open')
    expect(within(archive).getByRole('listitem', { name: 'Archived row', hidden: true })).not.toBeVisible()
    await user.click(within(archive).getByText('Archive (1)'))
    expect(disclosure).toHaveAttribute('open')
    expect(within(archive).getByText('Archived row')).toBeVisible()
  })

  it('nests a grandchild under labelled helper trees and never as a root row', async () => {
    const user = userEvent.setup()
    const nested = rows.map((parent) => ({
      ...parent,
      children: parent.children.map((child) => ({
        ...child,
        children: [
          row({
            task_id: 'grand-1',
            title: 'Check the label',
            section: 'working',
            phase: 'queued',
            summary: 'Nested',
          }),
        ],
      })),
    }))
    render(<TaskRail rows={nested} onOpen={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Expand Pin control' }))
    expect(screen.getByRole('list', { name: 'Helpers for Pin control' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Expand Write the control' }))
    expect(screen.getByRole('list', { name: 'Helpers for Write the control' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Check the label' })).toBeInTheDocument()
    expect(
      screen.getAllByRole('listitem').filter((item) => item.parentElement?.getAttribute('data-level') === 'root'),
    ).toHaveLength(1)
    const grandchild = screen.getByRole('listitem', { name: 'Check the label' })
    expect(grandchild.parentElement?.getAttribute('data-level')).toBe('2')
  })

  it('routes open and pin through typed callbacks and offers no per-row stop', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const onPin = vi.fn()
    render(<TaskRail rows={rows} onOpen={onOpen} onPin={onPin} />)
    await user.click(screen.getByRole('button', { name: 'Open Pin control' }))
    expect(onOpen).toHaveBeenCalledWith('task-1')
    await user.click(screen.getByRole('button', { name: 'Pin Pin control' }))
    expect(onPin).toHaveBeenCalledWith('task-1', 'pinned')
    await user.click(screen.getByRole('button', { name: 'Expand Pin control' }))
    expect(screen.queryByRole('button', { name: 'Stop Write the control' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop Pin control' })).not.toBeInTheDocument()
  })
})

describe('TaskDetail', () => {
  it('has no textbox and exposes the inspection records', () => {
    render(
      <TaskDetail
        detail={inspection}
        pin="unpinned"
        operation={{ kind: 'idle' }}
        onClose={vi.fn()}
        onQuote={vi.fn()}
        onPin={vi.fn()}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: 'Task detail' })
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(within(dialog).getByText('Add a pin control')).toBeInTheDocument()
    expect(within(dialog).getByText('Pin moves the row and keeps the envelope.')).toBeInTheDocument()
    expect(within(dialog).getByRole('list', { name: 'Transcript' })).toHaveTextContent('Editing the control.')
    expect(within(dialog).getByRole('list', { name: 'Tool events' })).toHaveTextContent('Updated pin handler')
    expect(within(dialog).getByRole('list', { name: 'Artifacts' })).toHaveTextContent('pin-control.diff')
    expect(within(dialog).getByRole('list', { name: 'Attempts' })).toHaveTextContent('Ready to review')
    expect(within(dialog).getByRole('list', { name: 'Criteria' })).toHaveTextContent('Pin control is visible')
    expect(within(dialog).getByRole('list', { name: 'Helpers' })).toHaveTextContent('Write the control')
    expect(within(dialog).getByText('None recorded.')).toBeInTheDocument()
  })

  it('routes quote, pin, and close through typed callbacks', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onQuote = vi.fn()
    const onPin = vi.fn()
    render(
      <TaskDetail
        detail={{
          ...inspection,
          attempts: [{ attempt_id: 'attempt-1', phase: 'running', summary: 'Editing' }],
        }}
        pin="unpinned"
        operation={{ kind: 'idle' }}
        onClose={onClose}
        onQuote={onQuote}
        onPin={onPin}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Quote task' }))
    expect(onQuote).toHaveBeenCalledWith('task-1')
    await user.click(screen.getByRole('button', { name: 'Pin this task' }))
    expect(onPin).toHaveBeenCalledWith('task-1', 'pinned')
    expect(screen.queryByRole('button', { name: 'Stop this task' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close detail' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('never offers Stop on task detail, even for a running task', () => {
    render(
      <TaskDetail
        detail={{
          ...inspection,
          attempts: [{ attempt_id: 'attempt-1', phase: 'running', summary: 'Editing' }],
        }}
        pin="unpinned"
        operation={{ kind: 'idle' }}
        onClose={vi.fn()}
        onQuote={vi.fn()}
        onPin={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Stop this task' })).not.toBeInTheDocument()
  })

  it('hides Stop for terminal task detail', () => {
    render(
      <TaskDetail
        detail={inspection}
        pin="unpinned"
        operation={{ kind: 'idle' }}
        onClose={vi.fn()}
        onQuote={vi.fn()}
        onPin={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Stop this task' })).not.toBeInTheDocument()
  })

  it('disables Quote task while send owns the draft', async () => {
    const user = userEvent.setup()
    const onQuote = vi.fn()
    render(
      <TaskDetail
        detail={inspection}
        pin="unpinned"
        operation={{ kind: 'sending' }}
        onClose={vi.fn()}
        onQuote={onQuote}
        onPin={vi.fn()}
      />,
    )

    const quote = screen.getByRole('button', { name: 'Quote task' })
    expect(quote).toBeDisabled()
    await user.click(quote)
    expect(onQuote).not.toHaveBeenCalled()
  })
})
