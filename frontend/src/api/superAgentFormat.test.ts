import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_PREVIEW_LIMIT,
  activityPreview,
  countActivity,
  formatPhase,
  phoneStopLabel,
  chatActivityLabel,
  taskStripLabel,
  shortWorkStatus,
  isNonTerminalPhase,
  routeFold,
  shownAcceptanceContext,
  inspectionGroups,
} from '@/api/superAgentFormat'
import type { SidebarRow, TaskDetail } from '@/api/superAgentTypes'

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

  it('speaks about the chat instead of dumping a long goal', () => {
    expect(chatActivityLabel({ running: 1, needsYou: 0 })).toBe('Working')
    expect(chatActivityLabel({ running: 0, needsYou: 1 })).toBe('Needs you')
    expect(chatActivityLabel({ running: 0, needsYou: 0 })).toBe('Quiet')
    expect(taskStripLabel([row({ task_id: 'done', section: 'completed', phase: 'completed' })])).toBe(
      'Tasks · 1 finished',
    )
    expect(
      shortWorkStatus('Working on I want you to investigate it and ideally fix the chat layout'),
    ).toBe('Working on investigate it and ideally fix…')
    expect(shortWorkStatus('Working on the phone layout')).toBe('Working on the phone layout')
  })

  it('labels a stopped phase as Stopped and keeps it resumable', () => {
    expect(formatPhase('stopped')).toBe('Stopped')
    expect(isNonTerminalPhase('stopped')).toBe(true)
  })
})

describe('chat presentation', () => {
  it('hides an ordinary admitted route and keeps a relay', () => {
    expect(routeFold('spawn_task')).toBeNull()
    expect(routeFold('continue_task')).toBeNull()
    expect(routeFold('link_task')).toBeNull()
    expect(routeFold('inspect_task')).toBeNull()
    expect(routeFold('cancel_task')).toBeNull()
    expect(routeFold('retry_task')).toBeNull()
    expect(routeFold('admit')).toBeNull()
    expect(routeFold('ask_user')).toBeNull()
    expect(routeFold('relay_report')).toEqual({
      summary: 'Relay · task report',
      detail: 'Untrusted task report, relayed as text.',
    })
    expect(routeFold('refuse')).toEqual({
      summary: 'Not done',
      detail: 'That message was not turned into work.',
    })
    expect(routeFold('mystery')).toEqual({
      summary: 'Route · admitted by host',
      detail: 'The host admitted the route.',
    })
  })

  it('drops the stock advisory line and empty inspection groups', () => {
    expect(shownAcceptanceContext('advisory')).toBeNull()
    expect(shownAcceptanceContext('  advisory  ')).toBeNull()
    expect(shownAcceptanceContext('')).toBeNull()
    expect(shownAcceptanceContext('It stands up')).toBe('It stands up')
    const detail: TaskDetail = {
      task_id: 'task-1',
      title: 'Pin control',
      original_prompt: 'Add a pin control',
      acceptance_context: 'advisory',
      transcript: [{ id: 'line-1', author: 'Parent', text: 'Editing the control.' }],
      tool_events: [],
      artifacts: [],
      attempts: [],
      decisions: [],
      criteria: [],
      helpers: [],
    }
    expect(inspectionGroups(detail).filter((group) => group.items.length > 0).map((group) => group.label)).toEqual([
      'Transcript',
    ])
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
