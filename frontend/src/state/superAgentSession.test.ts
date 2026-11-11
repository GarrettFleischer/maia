import { describe, expect, it } from 'vitest'
import type { RouterMessage, SidebarRow, TaskDetail } from '@/api/superAgentTypes'
import {
  createSuperAgentState,
  reduceSuperAgentState,
  type ClientActivationId,
  type ClientSessionId,
  type SendOperationToken,
  type SuperAgentEvent,
} from '@/state/superAgentSession'

const session = Symbol('session') as ClientSessionId
const activation = Symbol('activation') as ClientActivationId
const otherActivation = Symbol('other-activation') as ClientActivationId

const row = (taskId: string): SidebarRow => ({
  task_id: taskId,
  title: taskId,
  section: 'working',
  phase: 'running',
  summary: 'Running',
  elapsed_ms: 0,
  criteria_done: 0,
  criteria_total: 1,
  children: [],
})

const routerMessage = (messageId: string, text: string): RouterMessage => ({
  message_id: messageId,
  role: 'router',
  text,
})

const ownerMessage = (messageId: string, text: string): RouterMessage => ({
  message_id: messageId,
  role: 'owner',
  text,
})

const detail = (taskId: string): TaskDetail => ({
  task_id: taskId,
  title: taskId,
  original_prompt: taskId,
  acceptance_context: 'Complete',
  transcript: [],
  tool_events: [],
  artifacts: [],
  decisions: [],
  criteria: [],
  attempts: [],
  helpers: [],
})

function startedState() {
  return createSuperAgentState(session, activation)
}

function hydratedState() {
  const loading = reduceSuperAgentState(startedState(), {
    type: 'transcript_started',
    session,
    activation,
    request_id: 1,
    purpose: 'hydrate',
  })
  return reduceSuperAgentState(loading, {
    type: 'transcript_loaded',
    session,
    activation,
    request_id: 1,
    purpose: 'hydrate',
    messages: [],
  })
}

describe('reduceSuperAgentState transition validity', () => {
  const invalidTransitions: Array<{
    name: string
    prepare?: readonly SuperAgentEvent[]
    event: SuperAgentEvent
  }> = [
    {
      name: 'ignores a sidebar completion without a matching start',
      event: {
        type: 'sidebar_loaded',
        session,
        activation,
        request_id: 1,
        rows: [row('unexpected')],
        approvals: [],
      },
    },
    {
      name: 'ignores a regressing sidebar start',
      prepare: [
        { type: 'sidebar_started', session, activation, request_id: 2 },
      ],
      event: { type: 'sidebar_started', session, activation, request_id: 1 },
    },
    {
      name: 'ignores a sidebar failure for a different active request',
      prepare: [
        { type: 'sidebar_started', session, activation, request_id: 2 },
      ],
      event: { type: 'sidebar_failed', session, activation, request_id: 1 },
    },
    {
      name: 'ignores a transcript completion with the wrong purpose',
      prepare: [
        {
          type: 'transcript_started',
          session,
          activation,
          request_id: 1,
          purpose: 'hydrate',
        },
      ],
      event: {
        type: 'transcript_loaded',
        session,
        activation,
        request_id: 1,
        purpose: 'refresh',
        messages: [routerMessage('m-1', 'Unexpected')],
      },
    },
    {
      name: 'ignores a transcript failure after its request already completed',
      prepare: [
        {
          type: 'transcript_started',
          session,
          activation,
          request_id: 1,
          purpose: 'hydrate',
        },
        {
          type: 'transcript_loaded',
          session,
          activation,
          request_id: 1,
          purpose: 'hydrate',
          messages: [],
        },
      ],
      event: {
        type: 'transcript_failed',
        session,
        activation,
        request_id: 1,
        purpose: 'hydrate',
        text: 'Late failure',
      },
    },
    {
      name: 'ignores a completion from an old activation',
      prepare: [
        { type: 'sidebar_started', session, activation, request_id: 1 },
      ],
      event: {
        type: 'sidebar_loaded',
        session,
        activation: otherActivation,
        request_id: 1,
        rows: [row('old-activation')],
        approvals: [],
      },
    },
  ]

  for (const { name, prepare = [], event } of invalidTransitions) {
    it(name, () => {
      const before = prepare.reduce(reduceSuperAgentState, startedState())
      expect(reduceSuperAgentState(before, event)).toBe(before)
    })
  }

  it('accepts only an exact loading transcript owner', () => {
    const loading = reduceSuperAgentState(hydratedState(), {
      type: 'transcript_started',
      session,
      activation,
      request_id: 3,
      purpose: 'refresh',
    })
    const loaded = reduceSuperAgentState(loading, {
      type: 'transcript_loaded',
      session,
      activation,
      request_id: 3,
      purpose: 'refresh',
      messages: [routerMessage('m-3', 'Current')],
    })

    expect(loaded.transcript.messages).toEqual([routerMessage('m-3', 'Current')])
    expect(loaded.transcript.active_request).toBeNull()
  })
})

describe('reduceSuperAgentState send ownership', () => {
  it('ignores stale terminal events after a newer send token owns the operation', () => {
    const oldToken = Symbol('old-send') as SendOperationToken
    const newToken = Symbol('new-send') as SendOperationToken
    const oldSending = reduceSuperAgentState(hydratedState(), {
      type: 'send_started',
      session,
      activation,
      token: oldToken,
    })
    const oldFailed = reduceSuperAgentState(oldSending, {
      type: 'send_failed',
      session,
      activation,
      token: oldToken,
      text: 'Old failure',
    })
    const newSending = reduceSuperAgentState(oldFailed, {
      type: 'send_started',
      session,
      activation,
      token: newToken,
    })
    const staleTerminal = reduceSuperAgentState(newSending, {
      type: 'send_succeeded',
      session,
      activation,
      token: oldToken,
    })

    expect(staleTerminal).toBe(newSending)
    expect(staleTerminal.operation).toEqual({ kind: 'sending', token: newToken })
  })

  it('ignores send start before hydration establishes the baseline', () => {
    const before = startedState()
    const next = reduceSuperAgentState(before, {
      type: 'send_started',
      session,
      activation,
      token: Symbol('blocked-send') as SendOperationToken,
    })

    expect(next).toBe(before)
  })

  it('ignores all draft mutations while a send token owns the draft', () => {
    const token = Symbol('draft-owner') as SendOperationToken
    const drafted = reduceSuperAgentState(hydratedState(), {
      type: 'draft_changed',
      session,
      activation,
      draft: 'Owned draft',
    })
    const sending = reduceSuperAgentState(drafted, {
      type: 'send_started',
      session,
      activation,
      token,
    })
    const changed = reduceSuperAgentState(sending, {
      type: 'draft_changed',
      session,
      activation,
      draft: 'Later text',
    })
    const quoted = reduceSuperAgentState(sending, {
      type: 'draft_reference_inserted',
      session,
      activation,
      insert: 'task:task-1 ',
    })

    expect(changed).toBe(sending)
    expect(quoted).toBe(sending)
    expect(sending.draft).toBe('Owned draft')
  })

  it('clears a matching draft when admission arrives after the send was given up', () => {
    const token = Symbol('given-up') as SendOperationToken
    const drafted = reduceSuperAgentState(hydratedState(), {
      type: 'draft_changed',
      session,
      activation,
      draft: 'Status from the phone',
    })
    const sending = reduceSuperAgentState(drafted, {
      type: 'send_started',
      session,
      activation,
      token,
    })
    const failed = reduceSuperAgentState(sending, {
      type: 'send_failed',
      session,
      activation,
      token,
      text: 'Message failed. Try again.',
    })
    const admitted = reduceSuperAgentState(failed, {
      type: 'send_admitted',
      session,
      activation,
      token,
      sent_text: 'Status from the phone',
    })

    expect(admitted.draft).toBe('')
    expect(admitted.notice).toEqual({ kind: 'idle' })
  })

  it('leaves a newer draft when a late admission arrives', () => {
    const token = Symbol('given-up') as SendOperationToken
    const drafted = reduceSuperAgentState(hydratedState(), {
      type: 'draft_changed',
      session,
      activation,
      draft: 'Status from the phone',
    })
    const sending = reduceSuperAgentState(drafted, {
      type: 'send_started',
      session,
      activation,
      token,
    })
    const failed = reduceSuperAgentState(sending, {
      type: 'send_failed',
      session,
      activation,
      token,
      text: 'Message failed. Try again.',
    })
    const retyped = reduceSuperAgentState(failed, {
      type: 'draft_changed',
      session,
      activation,
      draft: 'Next question',
    })
    const admitted = reduceSuperAgentState(retyped, {
      type: 'send_admitted',
      session,
      activation,
      token,
      sent_text: 'Status from the phone',
    })

    expect(admitted).toBe(retyped)
    expect(admitted.draft).toBe('Next question')
  })

  it('notes a stored send that still has no reply once the composer is free', () => {
    const noted = reduceSuperAgentState(hydratedState(), {
      type: 'stored_send_unanswered',
      session,
      activation,
      text: 'The message was accepted, but its final outcome is unavailable.',
    })

    expect(noted.notice).toEqual({
      kind: 'admitted_failure',
      text: 'The message was accepted, but its final outcome is unavailable.',
    })
    expect(noted.operation).toEqual({ kind: 'idle' })
  })

  it('ignores an unanswered stored send while another send is in flight', () => {
    const token = Symbol('newer') as SendOperationToken
    const sending = reduceSuperAgentState(hydratedState(), {
      type: 'send_started',
      session,
      activation,
      token,
    })
    const noted = reduceSuperAgentState(sending, {
      type: 'stored_send_unanswered',
      session,
      activation,
      text: 'The message was accepted, but its final outcome is unavailable.',
    })

    expect(noted).toBe(sending)
  })
})

describe('reduceSuperAgentState detail ownership', () => {
  it('accepts detail completion only for the selected task, request, and purpose', () => {
    const openingB = reduceSuperAgentState(startedState(), {
      type: 'detail_started',
      session,
      activation,
      request_id: 2,
      purpose: 'open',
      task_id: 'task-b',
    })
    const staleA = reduceSuperAgentState(openingB, {
      type: 'detail_loaded',
      session,
      activation,
      request_id: 1,
      purpose: 'open',
      task_id: 'task-a',
      detail: detail('task-a'),
    })

    expect(staleA).toBe(openingB)
    expect(staleA.detail.selected_task_id).toBe('task-b')
  })

  it('rejects a detail payload whose task id differs from its matching request', () => {
    const openingA = reduceSuperAgentState(startedState(), {
      type: 'detail_started',
      session,
      activation,
      request_id: 1,
      purpose: 'open',
      task_id: 'task-a',
    })
    const mismatchedPayload = reduceSuperAgentState(openingA, {
      type: 'detail_loaded',
      session,
      activation,
      request_id: 1,
      purpose: 'open',
      task_id: 'task-a',
      detail: detail('task-b'),
    })

    expect(mismatchedPayload).toBe(openingA)
    expect(mismatchedPayload.detail.value).toBeNull()
  })
})

describe('reduceSuperAgentState announcement queue', () => {
  function load(
    state: ReturnType<typeof createSuperAgentState>,
    requestId: number,
    purpose: 'hydrate' | 'refresh',
    messages: readonly RouterMessage[],
  ) {
    const loading = reduceSuperAgentState(state, {
      type: 'transcript_started',
      session,
      activation,
      request_id: requestId,
      purpose,
    })
    return reduceSuperAgentState(loading, {
      type: 'transcript_loaded',
      session,
      activation,
      request_id: requestId,
      purpose,
      messages: [...messages],
    })
  }

  it('keeps hydration silent and advances one ordered event only after acknowledgement', () => {
    const hydrated = load(
      startedState(),
      1,
      'hydrate',
      [routerMessage('history', 'Initial history')],
    )
    const refreshed = load(hydrated, 2, 'refresh', [
      ownerMessage('owner', 'Never announce owner text'),
      routerMessage('router-1', 'Same text'),
      routerMessage('router-2', 'Same text'),
      routerMessage('router-3', 'Last text'),
    ])

    expect(refreshed.announcement_queue[0]).toEqual({
      sequence: 1,
      message_id: 'router-1',
      text: 'Same text',
    })
    expect(refreshed.announcement_queue).toHaveLength(3)

    const wrongAck = reduceSuperAgentState(refreshed, {
      type: 'announcement_acknowledged',
      session,
      activation,
      sequence: 2,
    })
    expect(wrongAck).toBe(refreshed)

    const advanced = reduceSuperAgentState(refreshed, {
      type: 'announcement_acknowledged',
      session,
      activation,
      sequence: 1,
    })
    expect(advanced.announcement_queue[0]).toEqual({
      sequence: 2,
      message_id: 'router-2',
      text: 'Same text',
    })
    expect(advanced.announcement_queue).toHaveLength(2)
  })

  it('suppresses duplicate and reintroduced IDs for the activation lifetime', () => {
    const initial = load(startedState(), 1, 'hydrate', [])
    const first = load(initial, 2, 'refresh', [routerMessage('router-1', 'First')])
    const removed = load(first, 3, 'refresh', [])
    const reintroduced = load(removed, 4, 'refresh', [
      routerMessage('router-1', 'Reintroduced'),
      routerMessage('router-1', 'Duplicate'),
    ])

    expect(reintroduced.announcement_queue).toHaveLength(1)
    expect(reintroduced.announcement_queue[0]?.text).toBe('First')
  })
})
