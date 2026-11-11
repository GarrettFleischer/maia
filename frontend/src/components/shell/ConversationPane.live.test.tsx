import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LiveApproval } from '@/api/superAgentTypes'
import { ConversationPane } from '@/components/shell/ConversationPane'
import type { RouterBindings } from '@/hooks/useSuperAgent'
import { renderWithMaia } from '@/test/renderWithMaia'

const APPROVAL: LiveApproval = {
  approval_id: '41',
  task_id: 'task-1',
  kind: 'capability',
  taint: 'untrusted',
  grant_text: 'Grant the capability this task requested',
  reason: 'This task is waiting for a capability grant.',
  created_at: 1,
  expires_at: 4_102_444_800,
}

function bindings(decideApproval: RouterBindings['decideApproval']): RouterBindings {
  return {
    messages: [{ message_id: 'm-1', role: 'router', text: 'Used a fact.' }],
    transcriptState: { kind: 'ready' },
    admittedStatusMessageId: null,
    admission: { kind: 'ready' },
    operation: { kind: 'idle' },
    announcement: null,
    draft: '',
    notice: { kind: 'idle' },
    detail: null,
    pinMark: 'unpinned',
    setDraft: () => undefined,
    acknowledgeAnnouncement: () => undefined,
    retryTranscript: async () => undefined,
    submit: async () => undefined,
    closeDetail: async () => undefined,
    quote: async () => undefined,
    pin: async () => undefined,
    hostCommand: async () => undefined,
    approvals: [APPROVAL],
    decideApproval,
    canAttach: false,
    stageAttachments: async () => undefined,
    outgoing: [],
    retryOutgoing: () => undefined,
    activity: [],
  }
}

describe('live needs-you', () => {
  it('keeps stop all visible and decides the grant from the sheet', async () => {
    const user = userEvent.setup()
    const decideApproval = vi.fn(async () => undefined)
    renderWithMaia(
      <ConversationPane
        dataSource="live"
        layout="phone"
        activityLabel="1 running · 1 needs you"
        onStopAll={() => undefined}
        phoneStop="1 running"
        router={bindings(decideApproval)}
        factsUsed={new Map([['m-1', ['claim-1']]])}
        onInspectFacts={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: 'Needs you' })).toBeVisible()
    expect(screen.getByText('This task is waiting for a capability grant.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Stop all running threads' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Facts used' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Needs you' }))
    expect(screen.getByText('Grant the capability this task requested')).toBeVisible()
    expect(screen.getByText('Untrusted')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(decideApproval).toHaveBeenCalledWith('41', 'approve')
  })
})

describe('openLiveApproval', () => {
  it('hides an approval whose expiry is already past', async () => {
    const { openLiveApproval } = await import('@/components/conversation/LiveApprovalNotice')
    expect(openLiveApproval([APPROVAL], APPROVAL.expires_at)).toBeNull()
    expect(openLiveApproval([APPROVAL], APPROVAL.expires_at - 1)?.approval_id).toBe('41')
  })
})
