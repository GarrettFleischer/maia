import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createFixtureSuperAgentClient } from '@/api/fixtureSuperAgent'
import type {
  MessageAdmissionResult,
  RouterMessage,
  SidebarRow,
  SuperAgentBackendScope,
  SubmissionOperationId,
  SuperAgentClient,
  TaskDetail,
} from '@/api/superAgentTypes'
import { SuperAgentRequestError } from '@/api/liveSuperAgent'
import { useSuperAgent } from '@/hooks/useSuperAgent'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function clientWith(overrides: Partial<SuperAgentClient>): SuperAgentClient {
  return { ...createFixtureSuperAgentClient(), ...overrides }
}

const row = (taskId: string, title: string): SidebarRow => ({
  task_id: taskId,
  title,
  section: 'working',
  phase: 'running',
  summary: 'Running',
  elapsed_ms: 0,
  criteria_done: 0,
  criteria_total: 1,
  children: [],
})

const message = (messageId: string, text: string): RouterMessage => ({
  message_id: messageId,
  role: 'router',
  text,
})

const ownerMessage = (messageId: string, text: string): RouterMessage => ({
  message_id: messageId,
  role: 'owner',
  text,
})

const routed = (): MessageAdmissionResult => ({
  admission: 'admitted',
  message_id: null,
  outcome: { kind: 'routed', route: 'admit' },
})

type ReviewedBindings = ReturnType<typeof useSuperAgent> & {
  announcement?: { sequence: number; message_id: string; text: string } | null
  acknowledgeAnnouncement?: (sequence: number) => void
  admission?: { kind: 'ready' } | { kind: 'blocked'; reason: 'hydrating' | 'hydrate_failed' }
}

const detail = (taskId: string): TaskDetail => ({
  task_id: taskId,
  title: taskId,
  original_prompt: taskId,
  acceptance_context: 'Complete',
  transcript: [],
  tool_events: [],
  artifacts: [],
  attempts: [],
  decisions: [],
  criteria: [],
  helpers: [],
})

describe('useSuperAgent resource ordering', () => {
  it('settles initial sidebar and transcript under React StrictMode', async () => {
    const client = clientWith({
      sidebar: vi.fn().mockResolvedValue({ rows: [row('strict-task', 'Strict task')] }),
      transcript: vi.fn().mockResolvedValue({
        messages: [message('strict-message', 'Strict transcript')],
      }),
    })
    const { result } = renderHook(() => useSuperAgent(client), {
      wrapper: StrictMode,
    })

    await waitFor(() => expect(result.current.rows).toEqual([row('strict-task', 'Strict task')]))
    await waitFor(() =>
      expect(result.current.messages).toEqual([message('strict-message', 'Strict transcript')]),
    )
    expect(result.current.transcriptState).toEqual({ kind: 'ready' })
  })

  it('hides fixture snapshots immediately while a replacement live client loads', async () => {
    const fixtureClient = clientWith({
      sidebar: vi.fn().mockResolvedValue({ rows: [row('fixture-task', 'Fixture task')] }),
      transcript: vi.fn().mockResolvedValue({
        messages: [message('fixture-message', 'Fixture transcript')],
      }),
    })
    const liveSidebar = deferred<{ rows: SidebarRow[] }>()
    const liveTranscript = deferred<{ messages: RouterMessage[] }>()
    const liveClient = clientWith({
      dataSource: 'live',
      sidebar: vi.fn().mockReturnValue(liveSidebar.promise),
      transcript: vi.fn().mockReturnValue(liveTranscript.promise),
    })
    const { result, rerender } = renderHook(
      ({ client }: { client: SuperAgentClient }) => useSuperAgent(client),
      { initialProps: { client: fixtureClient } },
    )
    await waitFor(() => expect(result.current.messages).toEqual([message('fixture-message', 'Fixture transcript')]))

    rerender({ client: liveClient })

    expect(result.current.rows).toEqual([])
    expect(result.current.messages).toEqual([])
    expect(result.current.transcriptState).toEqual({ kind: 'loading' })

    liveSidebar.resolve({ rows: [row('live-task', 'Live task')] })
    liveTranscript.resolve({ messages: [message('live-message', 'Live transcript')] })
    await waitFor(() => expect(result.current.messages).toEqual([message('live-message', 'Live transcript')]))
  })

  it('starts a fresh loading session when the same client returns after A to B to A', async () => {
    const nextARows = deferred<{ rows: SidebarRow[] }>()
    const nextATranscript = deferred<{ messages: RouterMessage[] }>()
    const clientA = clientWith({
      sidebar: vi
        .fn()
        .mockResolvedValueOnce({ rows: [row('a-old-task', 'A old task')] })
        .mockReturnValueOnce(nextARows.promise),
      transcript: vi
        .fn()
        .mockResolvedValueOnce({ messages: [message('a-old-message', 'A old transcript')] })
        .mockReturnValueOnce(nextATranscript.promise),
    })
    const clientB = clientWith({
      dataSource: 'live',
      sidebar: vi.fn().mockResolvedValue({ rows: [row('b-task', 'B task')] }),
      transcript: vi.fn().mockResolvedValue({ messages: [message('b-message', 'B transcript')] }),
    })
    const { result, rerender } = renderHook(
      ({ client }: { client: SuperAgentClient }) => useSuperAgent(client),
      { initialProps: { client: clientA } },
    )
    await waitFor(() => expect(result.current.messages).toEqual([message('a-old-message', 'A old transcript')]))

    rerender({ client: clientB })
    await waitFor(() => expect(result.current.messages).toEqual([message('b-message', 'B transcript')]))
    rerender({ client: clientA })

    expect(result.current.rows).toEqual([])
    expect(result.current.messages).toEqual([])
    expect(result.current.transcriptState).toEqual({ kind: 'loading' })

    nextARows.resolve({ rows: [row('a-new-task', 'A new task')] })
    nextATranscript.resolve({ messages: [message('a-new-message', 'A new transcript')] })
    await waitFor(() => expect(result.current.messages).toEqual([message('a-new-message', 'A new transcript')]))
  })

  it('does not start an old-client transcript refresh after unmount while send is pending', async () => {
    const pendingSend = deferred<MessageAdmissionResult>()
    const transcript = vi.fn().mockResolvedValue({ messages: [] })
    const client = clientWith({
      send: vi.fn().mockReturnValue(pendingSend.promise),
      transcript,
    })
    const { result, unmount } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(transcript).toHaveBeenCalledOnce())

    act(() => result.current.setDraft('Pending during unmount'))
    let submission!: Promise<void>
    act(() => {
      submission = result.current.submit()
    })
    unmount()
    pendingSend.resolve(routed())
    await act(async () => submission)

    expect(transcript).toHaveBeenCalledOnce()
  })

  it('does not start an old-client transcript refresh after client replacement while send is pending', async () => {
    const pendingSend = deferred<MessageAdmissionResult>()
    const oldTranscript = vi.fn().mockResolvedValue({
      messages: [message('m-old-initial', 'Old initial transcript')],
    })
    const oldClient = clientWith({
      send: vi.fn().mockReturnValue(pendingSend.promise),
      transcript: oldTranscript,
    })
    const newTranscript = vi.fn().mockResolvedValue({
      messages: [message('m-new-client', 'New client transcript')],
    })
    const newClient = clientWith({ transcript: newTranscript })
    const { result, rerender } = renderHook(
      ({ client }: { client: SuperAgentClient }) => useSuperAgent(client),
      { initialProps: { client: oldClient } },
    )
    await waitFor(() => expect(oldTranscript).toHaveBeenCalledOnce())

    act(() => result.current.setDraft('Pending during replacement'))
    let submission!: Promise<void>
    act(() => {
      submission = result.current.submit()
    })
    rerender({ client: newClient })
    await waitFor(() => expect(result.current.messages).toEqual([message('m-new-client', 'New client transcript')]))

    pendingSend.resolve(routed())
    await act(async () => submission)

    expect(oldTranscript).toHaveBeenCalledOnce()
    expect(newTranscript).toHaveBeenCalledOnce()
    expect(result.current.messages).toEqual([message('m-new-client', 'New client transcript')])
  })

  it('does not start a post-send refresh before initial hydration completes', async () => {
    const initial = deferred<{ messages: RouterMessage[] }>()
    const refreshed = deferred<{ messages: RouterMessage[] }>()
    const transcript = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise)
    const send = vi.fn().mockResolvedValue(routed())
    const client = clientWith({ transcript, send })
    const { result } = renderHook(() => useSuperAgent(client))

    act(() => result.current.setDraft('Route this'))
    let submission!: Promise<void>
    act(() => {
      submission = result.current.submit()
    })
    await act(async () => submission)
    expect(send).not.toHaveBeenCalled()
    expect(transcript).toHaveBeenCalledOnce()

    initial.resolve({ messages: [message('m-old', 'Old transcript')] })
    await waitFor(() =>
      expect(result.current.messages).toEqual([message('m-old', 'Old transcript')]),
    )
    act(() => {
      submission = result.current.submit()
    })
    await waitFor(() => expect(transcript).toHaveBeenCalledTimes(2))
    refreshed.resolve({
      messages: [
        message('m-old', 'Old transcript'),
        message('m-new', 'New transcript'),
      ],
    })
    await act(async () => submission)
    expect(result.current.messages).toEqual([
      message('m-old', 'Old transcript'),
      message('m-new', 'New transcript'),
    ])
  })

  it('shows a worker report in the router transcript when the sidebar updates', async () => {
    const transcript = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [message('m-old', 'The task started, but the worker did not answer.')],
      })
      .mockResolvedValueOnce({
        messages: [
          message('m-old', 'The task started, but the worker did not answer.'),
          message('m-report', 'The task reported: It is 54 F in Canby.'),
        ],
      })
    let pushRows: ((rows: SidebarRow[]) => void) | undefined
    const client = clientWith({
      transcript,
      sidebar: vi.fn().mockResolvedValue({ rows: [] }),
      subscribeSidebar(onRows) {
        pushRows = onRows
        return () => undefined
      },
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() =>
      expect(result.current.messages.map((item) => item.message_id)).toEqual(['m-old']),
    )

    act(() => {
      pushRows?.([row('task-1', 'Check the weather')])
    })

    await waitFor(() =>
      expect(result.current.messages.map((item) => item.text)).toEqual([
        'The task started, but the worker did not answer.',
        'The task reported: It is 54 F in Canby.',
      ]),
    )
  })

  it('does not let an older initial sidebar overwrite newer websocket rows', async () => {
    const initial = deferred<{ rows: SidebarRow[] }>()
    let pushRows: ((rows: SidebarRow[]) => void) | undefined
    const client = clientWith({
      sidebar: vi.fn().mockReturnValue(initial.promise),
      subscribeSidebar(onRows) {
        pushRows = onRows
        return () => undefined
      },
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(pushRows).toBeDefined())

    act(() => pushRows?.([row('task-new', 'New task')]))
    expect(result.current.rows).toEqual([row('task-new', 'New task')])

    initial.resolve({ rows: [row('task-old', 'Old task')] })
    await act(async () => initial.promise)
    expect(result.current.rows).toEqual([row('task-new', 'New task')])
  })
})

describe('useSuperAgent submission and transcript state', () => {
  it('lost and malformed responses retry with the same operation id', async () => {
    const cases = [
      { name: 'lost response', error: new Error('connection reset') },
      {
        name: 'malformed response',
        error: new SuperAgentRequestError('request_failed'),
      },
    ]
    for (const testCase of cases) {
      const operationId =
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as SubmissionOperationId
      const createOperationId = vi.fn(() => operationId)
      const send = vi
        .fn()
        .mockRejectedValueOnce(testCase.error)
        .mockResolvedValueOnce(routed())
      const transcript = vi.fn().mockResolvedValue({ messages: [] })
      const client = clientWith({ createOperationId, send, transcript })
      const { result, unmount } = renderHook(() => useSuperAgent(client))
      await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))

      act(() => result.current.setDraft(`Retry ${testCase.name}`))
      await act(async () => result.current.submit())
      expect(result.current.draft).toBe(`Retry ${testCase.name}`)
      await act(async () => result.current.submit())

      expect(createOperationId, testCase.name).toHaveBeenCalledOnce()
      expect(send, testCase.name).toHaveBeenNthCalledWith(
        1,
        operationId,
        `Retry ${testCase.name}`,
      )
      expect(send, testCase.name).toHaveBeenNthCalledWith(
        2,
        operationId,
        `Retry ${testCase.name}`,
      )
      expect(result.current.draft).toBe('')
      unmount()
    }
  })

  it('definitive pre-admission rejection discards the operation id', async () => {
    const ids = [
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ] as SubmissionOperationId[]
    const createOperationId = vi.fn(() => {
      const next = ids.shift()
      if (!next) throw new Error('missing operation id')
      return next
    })
    const send = vi
      .fn()
      .mockRejectedValueOnce(new SuperAgentRequestError('task_store_unavailable'))
      .mockResolvedValueOnce(routed())
    const client = clientWith({
      createOperationId,
      send,
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.admission).toEqual({ kind: 'ready' }))

    act(() => result.current.setDraft('Definitive retry'))
    await act(async () => result.current.submit())
    await act(async () => result.current.submit())

    expect(createOperationId).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[0]).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    expect(send.mock.calls[1]?.[0]).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  })

  it('ambiguous submission survives equivalent backend client replacement', async () => {
    const scope = 'live:http://127.0.0.1:4178' as SuperAgentBackendScope
    const operationId =
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as SubmissionOperationId
    const first = clientWith({
      backendScope: scope,
      createOperationId: vi.fn(() => operationId),
      send: vi.fn().mockRejectedValue(new Error('lost response')),
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
    })
    const replacementCreate = vi.fn(
      () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as SubmissionOperationId,
    )
    const replacementSend = vi.fn().mockResolvedValue(routed())
    const replacement = clientWith({
      backendScope: scope,
      createOperationId: replacementCreate,
      send: replacementSend,
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
    })
    const { result, rerender } = renderHook(
      ({ client }: { client: SuperAgentClient }) => useSuperAgent(client),
      { initialProps: { client: first } },
    )
    await waitFor(() => expect(result.current.admission).toEqual({ kind: 'ready' }))
    act(() => result.current.setDraft('Retained across wrapper'))
    await act(async () => result.current.submit())

    rerender({ client: replacement })
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))
    expect(result.current.draft).toBe('Retained across wrapper')
    await act(async () => result.current.submit())

    expect(replacementCreate).not.toHaveBeenCalled()
    expect(replacementSend).toHaveBeenCalledWith(operationId, 'Retained across wrapper')
  })

  it('session_unavailable retries with the same operation after equivalent client replacement', async () => {
    const scope = 'live:http://127.0.0.1:4178' as SuperAgentBackendScope
    const operationId =
      'abababab-abab-4bab-8bab-abababababab' as SubmissionOperationId
    const first = clientWith({
      backendScope: scope,
      createOperationId: vi.fn(() => operationId),
      send: vi.fn().mockRejectedValue(new SuperAgentRequestError('session_unavailable')),
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
    })
    const replacementCreate = vi.fn(
      () => 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd' as SubmissionOperationId,
    )
    const replacementSend = vi.fn().mockResolvedValue(routed())
    const replacement = clientWith({
      backendScope: scope,
      createOperationId: replacementCreate,
      send: replacementSend,
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
    })
    const { result, rerender } = renderHook(
      ({ client }: { client: SuperAgentClient }) => useSuperAgent(client),
      { initialProps: { client: first } },
    )
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))
    act(() => result.current.setDraft('Actor reply was lost'))
    await act(async () => result.current.submit())

    rerender({ client: replacement })
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))
    await act(async () => result.current.submit())

    expect(replacementCreate).not.toHaveBeenCalled()
    expect(replacementSend).toHaveBeenCalledWith(operationId, 'Actor reply was lost')
  })

  it.each([
    'invalid_json',
    'invalid_message',
    'invalid_operation_id',
    'empty_message',
    'unsupported_media_type',
    'payload_too_large',
    'task_store_unavailable',
    'submission_conflict',
  ])('discards operation ownership after proven pre-admission error %s', async (code) => {
    const ids = [
      'edededed-eded-4ded-8ded-edededededed',
      'fefefefe-fefe-4efe-8efe-fefefefefefe',
    ] as SubmissionOperationId[]
    const createOperationId = vi.fn(() => {
      const next = ids.shift()
      if (!next) throw new Error('missing operation id')
      return next
    })
    const send = vi
      .fn()
      .mockRejectedValueOnce(new SuperAgentRequestError(code))
      .mockResolvedValueOnce(routed())
    const client = clientWith({
      createOperationId,
      send,
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.admission).toEqual({ kind: 'ready' }))
    act(() => result.current.setDraft(`Disposition ${code}`))

    await act(async () => result.current.submit())
    await act(async () => result.current.submit())

    expect(createOperationId).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[0]).not.toBe(send.mock.calls[1]?.[0])
  })

  it('different backend scope discards ambiguous submission ownership', async () => {
    const firstId =
      'ffffffff-ffff-4fff-8fff-ffffffffffff' as SubmissionOperationId
    const secondId =
      '12121212-1212-4212-8212-121212121212' as SubmissionOperationId
    const first = clientWith({
      backendScope: 'live:http://127.0.0.1:4178' as SuperAgentBackendScope,
      createOperationId: vi.fn(() => firstId),
      send: vi.fn().mockRejectedValue(new Error('lost response')),
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
    })
    const secondCreate = vi.fn(() => secondId)
    const secondSend = vi.fn().mockResolvedValue(routed())
    const second = clientWith({
      backendScope: 'live:http://127.0.0.1:5000' as SuperAgentBackendScope,
      createOperationId: secondCreate,
      send: secondSend,
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
    })
    const { result, rerender } = renderHook(
      ({ client }: { client: SuperAgentClient }) => useSuperAgent(client),
      { initialProps: { client: first } },
    )
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))
    act(() => result.current.setDraft('Do not cross backend'))
    await act(async () => result.current.submit())

    rerender({ client: second })
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))
    expect(result.current.draft).toBe('')
    act(() => result.current.setDraft('Do not cross backend'))
    await act(async () => result.current.submit())

    expect(secondCreate).toHaveBeenCalledOnce()
    expect(secondSend).toHaveBeenCalledWith(secondId, 'Do not cross backend')
  })

  it('clears an admitted routing failure exactly once and refreshes its safe note', async () => {
    const safeMessages = [
      ownerMessage('m-owner-admitted', 'Route this once'),
      message('m-router-safe', 'The model provider is unavailable.'),
    ]
    const send = vi.fn().mockResolvedValue({
      admission: 'admitted',
      message_id: 'm-owner-admitted',
      outcome: {
        kind: 'routing_failed',
        reason: 'model_provider_unavailable',
      },
    })
    const transcript = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: safeMessages })
    const client = clientWith({ send, transcript })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))

    act(() => result.current.setDraft('Route this once'))
    await act(async () => result.current.submit())

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.any(String), 'Route this once')
    expect(result.current.draft).toBe('')
    expect(result.current.messages).toEqual(safeMessages)
    expect(result.current.notice).toEqual({ kind: 'idle' })
    expect(result.current.operation).toEqual({ kind: 'idle' })

    act(() => result.current.setDraft('A later message'))
    expect(result.current.draft).toBe('A later message')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('uses the specific safe routing outcome when its transcript refresh also fails', async () => {
    const send = vi.fn().mockResolvedValue({
      admission: 'admitted',
      message_id: 'm-provider-failure',
      outcome: {
        kind: 'routing_failed',
        reason: 'model_provider_unavailable',
      },
    })
    const transcript = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockRejectedValueOnce(new Error('provider=https://private.invalid token=sk-SECRET'))
    const client = clientWith({ send, transcript })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))

    act(() => result.current.setDraft('Admit before refresh failure'))
    await act(async () => result.current.submit())

    expect(result.current.draft).toBe('')
    expect(result.current.transcriptState).toEqual({
      kind: 'error',
      text: 'The conversation could not be refreshed.',
    })
    expect(result.current.notice).toEqual({
      kind: 'admitted_failure',
      text: 'The model provider is unavailable.',
    })
    expect(JSON.stringify(result.current)).not.toContain('private.invalid')
    expect(JSON.stringify(result.current)).not.toContain('sk-SECRET')
  })

  it('known and unknown admitted outcomes clear once and refresh once', async () => {
    const cases = [
      {
        name: 'processing failure',
        result: {
          admission: 'admitted',
          message_id: 'm-processing',
          outcome: {
            kind: 'processing_failed',
            reason: 'processing_unavailable',
          },
        },
        expected: 'The message was accepted, but processing could not continue.',
      },
      {
        name: 'unknown future outcome',
        result: {
          admission: 'admitted',
          message_id: 'm-unknown',
          outcome: { kind: 'unknown_outcome' },
        },
        expected: 'The message was accepted, but its outcome is unavailable.',
      },
    ] as const

    for (const testCase of cases) {
      const send = vi
        .fn()
        .mockResolvedValue(testCase.result as unknown as MessageAdmissionResult)
      const transcript = vi
        .fn()
        .mockResolvedValueOnce({ messages: [] })
        .mockRejectedValueOnce(new Error('private upstream detail'))
      const client = clientWith({ send, transcript })
      const { result, unmount } = renderHook(() => useSuperAgent(client))
      await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))

      act(() => result.current.setDraft(`Owned ${testCase.name}`))
      await act(async () => result.current.submit())

      expect(send, testCase.name).toHaveBeenCalledTimes(1)
      expect(transcript, testCase.name).toHaveBeenCalledTimes(2)
      expect(result.current.draft, testCase.name).toBe('')
      expect(result.current.transcriptState, testCase.name).toEqual({
        kind: 'error',
        text: 'The conversation could not be refreshed.',
      })
      expect(result.current.notice, testCase.name).toEqual({
        kind: 'admitted_failure',
        text: testCase.expected,
      })
      act(() => result.current.setDraft(`Later ${testCase.name}`))
      expect(result.current.draft, testCase.name).toBe(`Later ${testCase.name}`)
      expect(send, testCase.name).toHaveBeenCalledTimes(1)
      unmount()
    }
  })

  it('retains the draft when the store fails before admission', async () => {
    const send = vi.fn().mockRejectedValue(new SuperAgentRequestError('task_store_unavailable'))
    const transcript = vi.fn().mockResolvedValue({ messages: [] })
    const client = clientWith({ send, transcript })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))

    act(() => result.current.setDraft('Retry after store recovery'))
    await act(async () => result.current.submit())

    expect(send).toHaveBeenCalledOnce()
    expect(result.current.draft).toBe('Retry after store recovery')
    expect(result.current.messages).toEqual([])
    expect(result.current.notice).toEqual({
      kind: 'failed',
      text: 'The task store is unavailable.',
    })
  })

  it('does not admit while hydration is unresolved and announces only the new reply after the baseline', async () => {
    const initial = deferred<{ messages: RouterMessage[] }>()
    const oldHistory = message('m-old-history', 'Old history')
    const newReply = message('m-new-reply', 'New reply')
    const send = vi.fn().mockResolvedValue(routed())
    const transcript = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce({ messages: [oldHistory, newReply] })
    const client = clientWith({ send, transcript })
    const { result } = renderHook(() => useSuperAgent(client))
    act(() => result.current.setDraft('Wait for baseline'))

    await act(async () => result.current.submit())
    expect(send).not.toHaveBeenCalled()
    expect((result.current as ReviewedBindings).admission).toEqual({
      kind: 'blocked',
      reason: 'hydrating',
    })

    initial.resolve({ messages: [oldHistory] })
    await waitFor(() => expect(result.current.messages).toEqual([oldHistory]))
    await act(async () => result.current.submit())

    expect(send).toHaveBeenCalledOnce()
    expect(result.current.announcement).toEqual({
      sequence: 1,
      message_id: 'm-new-reply',
      text: 'New reply',
    })
  })

  it('keeps admission disabled after hydration failure until retry succeeds', async () => {
    const send = vi.fn().mockResolvedValue(routed())
    const transcript = vi
      .fn()
      .mockRejectedValueOnce(new Error('initial unavailable'))
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [] })
    const client = clientWith({ send, transcript })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState.kind).toBe('error'))
    act(() => result.current.setDraft('Blocked until retry'))

    await act(async () => result.current.submit())
    expect(send).not.toHaveBeenCalled()
    expect((result.current as ReviewedBindings).admission).toEqual({
      kind: 'blocked',
      reason: 'hydrate_failed',
    })

    await act(async () => result.current.retryTranscript())
    expect((result.current as ReviewedBindings).admission).toEqual({ kind: 'ready' })
    await act(async () => result.current.submit())
    expect(send).toHaveBeenCalledOnce()
  })

  it('enables admission after successful empty fixture hydration', async () => {
    const send = vi.fn().mockResolvedValue(routed())
    const client = clientWith({
      send,
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.admission).toEqual({ kind: 'ready' }))
    expect((result.current as ReviewedBindings).admission).toEqual({ kind: 'ready' })

    act(() => result.current.setDraft('Fixture can send'))
    await act(async () => result.current.submit())
    expect(send).toHaveBeenCalledOnce()
  })

  it('retains send ownership through synchronous throw recovery before immediate resubmit', async () => {
    const recovery = deferred<{ messages: RouterMessage[] }>()
    const send = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('synchronous failure')
      })
      .mockResolvedValue(routed())
    const transcript = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockReturnValueOnce(recovery.promise)
      .mockResolvedValue({ messages: [] })
    const client = clientWith({ send, transcript })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))
    act(() => result.current.setDraft('Retry only after terminal recovery'))

    let first!: Promise<void>
    let overlapping!: Promise<void>
    act(() => {
      first = result.current.submit()
      overlapping = result.current.submit()
    })
    expect(send).toHaveBeenCalledOnce()

    recovery.resolve({ messages: [] })
    await act(async () => Promise.all([first, overlapping]))
    await act(async () => result.current.submit())
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('retains send ownership through rejected promise recovery before immediate resubmit', async () => {
    const rejection = deferred<MessageAdmissionResult>()
    const recovery = deferred<{ messages: RouterMessage[] }>()
    const send = vi
      .fn()
      .mockReturnValueOnce(rejection.promise)
      .mockResolvedValue(routed())
    const transcript = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockReturnValueOnce(recovery.promise)
      .mockResolvedValue({ messages: [] })
    const client = clientWith({ send, transcript })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))
    act(() => result.current.setDraft('Rejected send'))

    let first!: Promise<void>
    act(() => {
      first = result.current.submit()
    })
    rejection.reject(new Error('rejected failure'))
    await waitFor(() => expect(transcript).toHaveBeenCalledTimes(2))
    let overlapping!: Promise<void>
    act(() => {
      overlapping = result.current.submit()
    })
    expect(send).toHaveBeenCalledOnce()

    recovery.resolve({ messages: [] })
    await act(async () => Promise.all([first, overlapping]))
    await act(async () => result.current.submit())
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('allows no overlapping send or transcript retry while send is pending', async () => {
    const pendingSend = deferred<MessageAdmissionResult>()
    const send = vi.fn().mockReturnValue(pendingSend.promise)
    const transcript = vi
      .fn()
      .mockRejectedValueOnce(new Error('initial transcript unavailable'))
      .mockResolvedValue({ messages: [] })
    const client = clientWith({ send, transcript })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState.kind).toBe('error'))
    await act(async () => result.current.retryTranscript())
    expect(result.current.transcriptState).toEqual({ kind: 'empty' })
    act(() => result.current.setDraft('Send once'))

    let firstSend!: Promise<void>
    let retry!: Promise<void>
    let secondSend!: Promise<void>
    act(() => {
      firstSend = result.current.submit()
      retry = result.current.retryTranscript()
      secondSend = result.current.submit()
    })
    const sendCallsWhilePending = send.mock.calls.length
    const transcriptCallsWhilePending = transcript.mock.calls.length

    pendingSend.resolve(routed())
    await act(async () => Promise.all([firstSend, retry, secondSend]))

    expect(sendCallsWhilePending).toBe(1)
    expect(transcriptCallsWhilePending).toBe(2)
  })

  it('clears an admitted draft and exposes a retryable transcript refresh failure', async () => {
    const retry = deferred<{ messages: RouterMessage[] }>()
    const send = vi.fn().mockResolvedValue(routed())
    const transcript = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockRejectedValueOnce(new Error('provider=https://private.invalid token=sk-SECRET'))
      .mockReturnValueOnce(retry.promise)
    const client = clientWith({ send, transcript })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(transcript).toHaveBeenCalledOnce())

    act(() => result.current.setDraft('Admit exactly once'))
    await act(async () => result.current.submit())

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.current.draft).toBe('')
    expect(result.current.notice).toEqual({
      kind: 'refresh_failed',
      text: 'Message sent. Refresh the conversation to see the latest reply.',
    })
    expect(result.current.transcriptState).toEqual({
      kind: 'error',
      text: 'The conversation could not be refreshed.',
    })
    expect(JSON.stringify(result.current)).not.toContain('private.invalid')
    expect(JSON.stringify(result.current)).not.toContain('sk-SECRET')

    let retryRequest!: Promise<void>
    act(() => {
      retryRequest = result.current.retryTranscript()
    })
    expect(result.current.transcriptState).toEqual({ kind: 'loading' })
    expect(result.current.notice).toEqual({ kind: 'idle' })
    retry.resolve({ messages: [message('m-retried', 'Refreshed safely')] })
    await act(async () => retryRequest)
    expect(send).toHaveBeenCalledTimes(1)
    expect(result.current.messages).toEqual([message('m-retried', 'Refreshed safely')])
    expect(result.current.transcriptState).toEqual({ kind: 'ready' })
    expect(result.current.notice).toEqual({ kind: 'idle' })
  })

  it('clears a failed-send notice when the retained draft is edited', async () => {
    const client = clientWith({
      send: vi.fn().mockRejectedValue(new Error('send failed with private detail')),
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))

    act(() => result.current.setDraft('Original draft'))
    await act(async () => result.current.submit())
    expect(result.current.notice).toEqual({ kind: 'failed', text: 'Message failed. Try again.' })
    expect(result.current.draft).toBe('Original draft')

    act(() => result.current.setDraft('Edited draft'))
    expect(result.current.notice).toEqual({ kind: 'idle' })
  })

  it('ignores quote and draft mutations while a deferred send owns the draft', async () => {
    const pendingSend = deferred<MessageAdmissionResult>()
    const insertReference = vi.fn().mockResolvedValue({ composer_insert: 'task:task-1 ' })
    const client = clientWith({
      send: vi.fn().mockReturnValue(pendingSend.promise),
      transcript: vi.fn().mockResolvedValue({ messages: [] }),
      insertReference,
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))
    act(() => result.current.setDraft('Owned draft'))

    let submission!: Promise<void>
    act(() => {
      submission = result.current.submit()
    })
    await act(async () => result.current.quote('task-1'))
    act(() => result.current.setDraft('Later intent'))

    expect(insertReference).not.toHaveBeenCalled()
    expect(result.current.draft).toBe('Owned draft')

    pendingSend.resolve(routed())
    await act(async () => submission)
    act(() => result.current.setDraft('Later intent'))
    expect(result.current.draft).toBe('Later intent')
  })

  it('starts transcript loading before the initial request settles', () => {
    const initial = deferred<{ messages: RouterMessage[] }>()
    const client = clientWith({ transcript: vi.fn().mockReturnValue(initial.promise) })
    const { result } = renderHook(() => useSuperAgent(client))
    expect(result.current.transcriptState).toEqual({ kind: 'loading' })
  })

  it('exposes a safe initial transcript error and retries to an empty state', async () => {
    const transcript = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider=https://private.invalid token=sk-SECRET'))
      .mockResolvedValueOnce({ messages: [] })
    const client = clientWith({ transcript })
    const { result } = renderHook(() => useSuperAgent(client))

    await waitFor(() =>
      expect(result.current.transcriptState).toEqual({
        kind: 'error',
        text: 'The conversation could not be loaded.',
      }),
    )
    expect(JSON.stringify(result.current)).not.toContain('private.invalid')
    expect(JSON.stringify(result.current)).not.toContain('sk-SECRET')

    await act(async () => result.current.retryTranscript())
    expect(result.current.transcriptState).toEqual({ kind: 'empty' })
  })
})

describe('useSuperAgent transcript identity and announcements', () => {
  it('deduplicates initial message IDs and keeps hydration silent', async () => {
    const duplicate = message('m-duplicate', 'Initial router history')
    const client = clientWith({
      transcript: vi.fn().mockResolvedValue({ messages: [duplicate, duplicate] }),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'ready' }))
    const reviewed = result.current as ReviewedBindings

    expect(reviewed.messages).toEqual([duplicate])
    expect(reviewed.announcement).toBeNull()
  })

  it('does not re-announce a removed and reintroduced router message ID', async () => {
    const original = message('m-original', 'Original router message')
    const transcript = vi
      .fn()
      .mockResolvedValueOnce({ messages: [original] })
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValueOnce({ messages: [original] })
    const client = clientWith({
      send: vi.fn().mockResolvedValue(routed()),
      transcript,
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.messages).toEqual([original]))

    act(() => result.current.setDraft('Remove snapshot'))
    await act(async () => result.current.submit())
    act(() => result.current.setDraft('Reintroduce snapshot'))
    await act(async () => result.current.submit())
    const reviewed = result.current as ReviewedBindings

    expect(reviewed.messages).toEqual([original])
    expect(reviewed.announcement).toBeNull()
  })

  it('announces every new router ID once in order, including identical text in one batch', async () => {
    const batch = [
      ownerMessage('m-owner', 'Never announce owner text'),
      message('m-router-1', 'Same text'),
      message('m-router-2', 'Same text'),
      message('m-router-3', 'Final text'),
      message('m-router-2', 'Duplicate ID is rejected'),
    ]
    const transcript = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValue({ messages: batch })
    const client = clientWith({
      send: vi.fn().mockResolvedValue(routed()),
      transcript,
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.transcriptState).toEqual({ kind: 'empty' }))

    act(() => result.current.setDraft('Load batch'))
    await act(async () => result.current.submit())
    act(() => result.current.setDraft('Load same batch again'))
    await act(async () => result.current.submit())
    const reviewed = result.current as ReviewedBindings

    expect(reviewed.messages.map((item) => item.message_id)).toEqual([
      'm-owner',
      'm-router-1',
      'm-router-2',
      'm-router-3',
    ])
    expect(reviewed.announcement).toEqual({
      sequence: 1,
      message_id: 'm-router-1',
      text: 'Same text',
    })
    act(() => reviewed.acknowledgeAnnouncement?.(1))
    expect(result.current.announcement).toEqual({
      sequence: 2,
      message_id: 'm-router-2',
      text: 'Same text',
    })
    act(() => result.current.acknowledgeAnnouncement(2))
    expect(result.current.announcement).toEqual({
      sequence: 3,
      message_id: 'm-router-3',
      text: 'Final text',
    })
    act(() => result.current.acknowledgeAnnouncement(3))
    expect(result.current.announcement).toBeNull()
  })
})

describe('useSuperAgent detail ordering', () => {
  it('keeps B detail when open A resolves after open B', async () => {
    const taskA = deferred<TaskDetail>()
    const taskB = deferred<TaskDetail>()
    const client = clientWith({
      task: vi.fn((taskId: string) => {
        if (taskId === 'task-a') return taskA.promise
        if (taskId === 'task-b') return taskB.promise
        return Promise.reject(new Error('unknown task'))
      }),
      openDetail: vi.fn().mockResolvedValue({ view: 'open' }),
    })
    const { result } = renderHook(() => useSuperAgent(client))

    let openA!: Promise<void>
    let openB!: Promise<void>
    act(() => {
      openA = result.current.openTask('task-a')
      openB = result.current.openTask('task-b')
    })
    taskB.resolve(detail('task-b'))
    await act(async () => openB)
    expect(result.current.detail?.task_id).toBe('task-b')

    taskA.resolve(detail('task-a'))
    await act(async () => openA)
    expect(result.current.detail?.task_id).toBe('task-b')
  })

  it('keeps the selected detail when a host refresh resolves after a newer open', async () => {
    const refreshA = deferred<TaskDetail>()
    let taskACalls = 0
    const client = clientWith({
      task: vi.fn((taskId: string) => {
        if (taskId === 'task-a') {
          taskACalls += 1
          return taskACalls === 1 ? Promise.resolve(detail('task-a')) : refreshA.promise
        }
        if (taskId === 'task-b') return Promise.resolve(detail('task-b'))
        return Promise.reject(new Error('unknown task'))
      }),
      openDetail: vi.fn().mockResolvedValue({ view: 'open' }),
      hostCommand: vi.fn().mockResolvedValue({ phase: 'running' }),
      sidebar: vi.fn().mockResolvedValue({ rows: [] }),
    })
    const { result } = renderHook(() => useSuperAgent(client))

    await act(async () => result.current.openTask('task-a'))
    let refresh!: Promise<void>
    act(() => {
      refresh = result.current.hostCommand({ command: 'stop', task_id: 'task-a' })
    })
    await waitFor(() => expect(client.task).toHaveBeenCalledTimes(2))
    await act(async () => result.current.openTask('task-b'))
    expect(result.current.detail?.task_id).toBe('task-b')

    refreshA.resolve(detail('task-a'))
    await act(async () => refresh)
    expect(result.current.detail?.task_id).toBe('task-b')
  })
})

describe('useSuperAgent repeated shell actions', () => {
  it('coalesces repeated close while pending', async () => {
    const pending = deferred<{ view: 'closed_once' }>()
    const client = clientWith({
      task: vi.fn().mockResolvedValue(detail('task-a')),
      openDetail: vi.fn().mockResolvedValue({ view: 'open' }),
      closeDetail: vi.fn().mockReturnValue(pending.promise),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await act(async () => result.current.openTask('task-a'))

    let first!: Promise<void>
    let repeated!: Promise<void>
    act(() => {
      first = result.current.closeDetail()
      repeated = result.current.closeDetail()
    })

    expect(client.closeDetail).toHaveBeenCalledOnce()
    pending.resolve({ view: 'closed_once' })
    await act(async () => Promise.all([first, repeated]))
  })

  it('coalesces repeated pin while pending', async () => {
    const pending = deferred<{ pin: 'pinned' }>()
    const client = clientWith({
      pin: vi.fn().mockReturnValue(pending.promise),
    })
    const { result } = renderHook(() => useSuperAgent(client))

    let first!: Promise<void>
    let repeated!: Promise<void>
    act(() => {
      first = result.current.pin('task-a', 'pinned')
      repeated = result.current.pin('task-a', 'pinned')
    })

    expect(client.pin).toHaveBeenCalledOnce()
    pending.resolve({ pin: 'pinned' })
    await act(async () => Promise.all([first, repeated]))
  })

  it('coalesces repeated host command while pending', async () => {
    const pending = deferred<{ phase: 'cancelled' }>()
    const client = clientWith({
      hostCommand: vi.fn().mockReturnValue(pending.promise),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    const command = { command: 'stop_all' } as const

    let first!: Promise<void>
    let repeated!: Promise<void>
    act(() => {
      first = result.current.hostCommand(command)
      repeated = result.current.hostCommand(command)
    })

    expect(client.hostCommand).toHaveBeenCalledOnce()
    pending.resolve({ phase: 'cancelled' })
    await act(async () => Promise.all([first, repeated]))
  })

  it('allows independent actions on the same and other tasks while one is pending', async () => {
    const pinA = deferred<{ pin: 'pinned' }>()
    const pinB = deferred<{ pin: 'unpinned' }>()
    const close = deferred<{ view: 'closed_once' }>()
    const stop = deferred<{ phase: 'cancelled' }>()
    const client = clientWith({
      task: vi.fn().mockResolvedValue(detail('task-a')),
      openDetail: vi.fn().mockResolvedValue({ view: 'open' }),
      pin: vi
        .fn()
        .mockReturnValueOnce(pinA.promise)
        .mockReturnValueOnce(pinB.promise),
      closeDetail: vi.fn().mockReturnValue(close.promise),
      hostCommand: vi.fn().mockReturnValue(stop.promise),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await act(async () => result.current.openTask('task-a'))

    let firstPin!: Promise<void>
    let differentPin!: Promise<void>
    let closeDetail!: Promise<void>
    let stopTask!: Promise<void>
    act(() => {
      firstPin = result.current.pin('task-a', 'pinned')
      differentPin = result.current.pin('task-b', 'unpinned')
      closeDetail = result.current.closeDetail()
      stopTask = result.current.hostCommand({ command: 'stop', task_id: 'task-a' })
    })

    expect(client.pin).toHaveBeenCalledTimes(2)
    expect(client.closeDetail).toHaveBeenCalledOnce()
    expect(client.hostCommand).toHaveBeenCalledOnce()

    pinA.resolve({ pin: 'pinned' })
    pinB.resolve({ pin: 'unpinned' })
    close.resolve({ view: 'closed_once' })
    stop.resolve({ phase: 'cancelled' })
    await act(async () =>
      Promise.all([firstPin, differentPin, closeDetail, stopTask]),
    )
  })

  it('allows a different payload for the same task while deduplicating the exact pin', async () => {
    const pinned = deferred<{ pin: 'pinned' }>()
    const unpinned = deferred<{ pin: 'unpinned' }>()
    const client = clientWith({
      pin: vi
        .fn()
        .mockReturnValueOnce(pinned.promise)
        .mockReturnValueOnce(unpinned.promise),
    })
    const { result } = renderHook(() => useSuperAgent(client))

    let first!: Promise<void>
    let duplicate!: Promise<void>
    let different!: Promise<void>
    act(() => {
      first = result.current.pin('task-a', 'pinned')
      duplicate = result.current.pin('task-a', 'pinned')
      different = result.current.pin('task-a', 'unpinned')
    })

    expect(client.pin).toHaveBeenCalledTimes(2)
    pinned.resolve({ pin: 'pinned' })
    unpinned.resolve({ pin: 'unpinned' })
    await act(async () => Promise.all([first, duplicate, different]))
  })

  it('client replacement keeps old action cleanup from releasing the new owner', async () => {
    const oldPending = deferred<{ pin: 'pinned' }>()
    const newPending = deferred<{ pin: 'pinned' }>()
    const first = clientWith({
      pin: vi.fn().mockReturnValue(oldPending.promise),
    })
    const replacementPin = vi.fn().mockReturnValue(newPending.promise)
    const replacement = clientWith({ pin: replacementPin })
    const { result, rerender, unmount } = renderHook(
      ({ client }: { client: SuperAgentClient }) => useSuperAgent(client),
      { initialProps: { client: first } },
    )

    let oldAction!: Promise<void>
    act(() => {
      oldAction = result.current.pin('task-a', 'pinned')
    })
    rerender({ client: replacement })
    let newAction!: Promise<void>
    act(() => {
      newAction = result.current.pin('task-a', 'pinned')
    })
    oldPending.resolve({ pin: 'pinned' })
    await act(async () => oldAction)
    await act(async () => result.current.pin('task-a', 'pinned'))
    expect(replacementPin).toHaveBeenCalledOnce()

    unmount()
    newPending.resolve({ pin: 'pinned' })
    await expect(newAction).resolves.toBeUndefined()
  })
})

describe('useSuperAgent shell action failures', () => {
  it('reports a synchronous quote failure with safe copy', async () => {
    const client = clientWith({
      insertReference: vi.fn(() => {
        throw new SuperAgentRequestError('unknown_task')
      }),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.admission).toEqual({ kind: 'ready' }))

    await act(async () => result.current.quote('missing'))

    expect(result.current.notice).toEqual({
      kind: 'failed',
      text: 'That task is not available.',
    })
    expect(result.current.draft).toBe('')
  })

  it('reports an asynchronous quote failure with generic safe copy', async () => {
    const client = clientWith({
      insertReference: vi.fn().mockRejectedValue(new Error('private failure detail')),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await waitFor(() => expect(result.current.admission).toEqual({ kind: 'ready' }))

    await act(async () => result.current.quote('task-a'))

    expect(result.current.notice).toEqual({
      kind: 'failed',
      text: 'The task reference could not be inserted. Try again.',
    })
    expect(JSON.stringify(result.current)).not.toContain('private failure detail')
  })

  it('does not publish a stale quote after client replacement or unmount', async () => {
    const pending = deferred<{ composer_insert: string }>()
    const first = clientWith({
      insertReference: vi.fn().mockReturnValue(pending.promise),
    })
    const replacement = clientWith({
      insertReference: vi.fn().mockResolvedValue({ composer_insert: 'task:new ' }),
    })
    const { result, rerender, unmount } = renderHook(
      ({ client }: { client: SuperAgentClient }) => useSuperAgent(client),
      { initialProps: { client: first } },
    )

    let oldQuote!: Promise<void>
    act(() => {
      oldQuote = result.current.quote('task-old')
    })
    rerender({ client: replacement })
    pending.resolve({ composer_insert: 'task:old ' })
    await act(async () => oldQuote)
    expect(result.current.draft).toBe('')

    await act(async () => result.current.quote('task-new'))
    expect(result.current.draft).toBe('task:new ')
    unmount()
    await expect(result.current.quote('after-unmount')).resolves.toBeUndefined()
  })

  it('settles a rejected quote after unmount without publishing', async () => {
    const pending = deferred<{ composer_insert: string }>()
    const client = clientWith({
      insertReference: vi.fn().mockReturnValue(pending.promise),
    })
    const { result, unmount } = renderHook(() => useSuperAgent(client))
    let quote!: Promise<void>
    act(() => {
      quote = result.current.quote('task-a')
    })

    unmount()
    pending.reject(new Error('private stale failure'))

    await expect(quote).resolves.toBeUndefined()
  })

  it('reports a safe pin failure', async () => {
    const client = clientWith({
      pin: vi.fn().mockRejectedValue(new SuperAgentRequestError('invalid_pin')),
    })
    const { result } = renderHook(() => useSuperAgent(client))

    await act(async () => result.current.pin('task-a', 'pinned'))

    expect(result.current.notice).toEqual({
      kind: 'failed',
      text: 'That pin was not applied.',
    })
  })

  it('reports a safe close failure and keeps the detail open', async () => {
    const client = clientWith({
      task: vi.fn().mockResolvedValue(detail('task-a')),
      openDetail: vi.fn().mockResolvedValue({ view: 'open' }),
      closeDetail: vi.fn().mockRejectedValue(new SuperAgentRequestError('detail_not_open')),
    })
    const { result } = renderHook(() => useSuperAgent(client))
    await act(async () => result.current.openTask('task-a'))

    await act(async () => result.current.closeDetail())

    expect(result.current.detail?.task_id).toBe('task-a')
    expect(result.current.notice).toEqual({
      kind: 'failed',
      text: 'Open the detail before closing it.',
    })
  })

  it('reports a safe host-command failure', async () => {
    const client = clientWith({
      hostCommand: vi.fn().mockRejectedValue(new SuperAgentRequestError('command_rejected')),
    })
    const { result } = renderHook(() => useSuperAgent(client))

    await act(async () => result.current.hostCommand({ command: 'stop_all' }))

    expect(result.current.notice).toEqual({
      kind: 'failed',
      text: 'That command was not applied.',
    })
  })
})
