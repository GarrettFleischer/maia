import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TaskDetail as TaskDetailData } from '@/api/superAgentTypes'
import { TaskDetail } from '@/components/shell/TaskDetail'

const detail: TaskDetailData = {
  task_id: 'task-a',
  title: 'Dog house',
  original_prompt: 'Build a dog house',
  acceptance_context: 'It stands up',
  transcript: [{ id: 'line-1', author: 'Maia', text: 'Cutting lumber' }],
  tool_events: [],
  artifacts: [],
  attempts: [],
  decisions: [],
  criteria: [],
  helpers: [],
}

function renderDetail(onClose = vi.fn()) {
  render(
    <TaskDetail
      detail={detail}
      pin="unpinned"
      operation={{ kind: 'idle' }}
      onClose={onClose}
      onQuote={() => undefined}
      onPin={() => undefined}
    />,
  )
  return onClose
}

describe('TaskDetail close controls', () => {
  it('keeps Back and Close in the top bar at a 44px target', () => {
    renderDetail()
    const back = screen.getByRole('button', { name: 'Back to chat' })
    const close = screen.getByRole('button', { name: 'Close' })
    expect(back.closest('.maia-task-detail-bar')).not.toBeNull()
    expect(close.closest('.maia-task-detail-bar')).not.toBeNull()
    expect(back).toHaveStyle({ minHeight: '44px', minWidth: '44px' })
    expect(close).toHaveStyle({ minHeight: '44px', minWidth: '44px' })
  })

  it('closes on Escape', () => {
    const onClose = renderDetail()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on the Close button', async () => {
    const user = userEvent.setup()
    const onClose = renderDetail()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on the phone back gesture', () => {
    const onClose = renderDetail()
    fireEvent.popState(window)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
