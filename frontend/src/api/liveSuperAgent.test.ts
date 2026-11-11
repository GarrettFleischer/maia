import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from '@/App'
import { liveSuperAgentClient, selectSuperAgentClient, SuperAgentRequestError } from '@/api/liveSuperAgent'
import type {
  SubmissionOperationId,
  SuperAgentClient,
} from '@/api/superAgentTypes'

const ROW = {
  task_id: 'task-1',
  title: 'Pin control',
  section: 'working',
  phase: 'queued',
  summary: 'Queued',
  elapsed_ms: 0,
  criteria_done: 0,
  criteria_total: 1,
  children: [],
}

class FakeSocket {
  static instances: FakeSocket[] = []
  url: string
  onmessage: ((event: MessageEvent) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(data: string) {
    void data
  }

  close() {
    this.closed = true
    this.onclose?.()
  }

  emit(data: string) {
    this.onmessage?.({ data } as MessageEvent)
  }

  emitOpen() {
    this.onopen?.()
  }

  emitError() {
    this.onerror?.()
  }

  emitClose() {
    this.onclose?.()
  }
}

interface ScheduledReconnect {
  id: number
  delay_ms: number
  callback: () => void
  cancelled: boolean
}

function socketHarness() {
  const sockets: FakeSocket[] = []
  const scheduled: ScheduledReconnect[] = []
  let nextId = 1
  const ports = {
    connect(url: string) {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    schedule(delayMs: number, callback: () => void) {
      const item = {
        id: nextId++,
        delay_ms: delayMs,
        callback,
        cancelled: false,
      }
      scheduled.push(item)
      return item.id
    },
    cancel(handle: unknown) {
      const item = scheduled.find((candidate) => candidate.id === handle)
      if (item) item.cancelled = true
    },
    reconnect_delays_ms: [10, 20] as const,
  }
  const runNext = () => {
    const next = scheduled.find((item) => !item.cancelled)
    if (!next) return
    next.cancelled = true
    next.callback()
  }
  return { ports, sockets, scheduled, runNext }
}

type ReviewedLiveClient = SuperAgentClient & { dispose: () => void }
type ReviewedLiveFactory = (
  origin: string,
  generateOperationId?: () => SubmissionOperationId,
  socketPorts?: ReturnType<typeof socketHarness>['ports'],
) => ReviewedLiveClient

function recordedCall(fetchMock: { mock: { calls: readonly unknown[] } }, index = 0): [unknown, RequestInit] {
  const call = fetchMock.mock.calls[index] as unknown as readonly [unknown, RequestInit] | undefined
  if (!call) throw new Error('missing fetch call')
  return [call[0], call[1]]
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function send(client: ReturnType<typeof liveSuperAgentClient>, text: string) {
  return client.send(client.createOperationId(), text)
}

describe('liveSuperAgentClient', () => {
  it('posts the supplied operation id without generating a replacement', async () => {
    const operationId =
      '11111111-1111-4111-8111-111111111111' as SubmissionOperationId
    const generate = vi.fn(() => operationId)
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        admitted: 'admit',
        admission: 'admitted',
        message_id: 'm-1',
        outcome: { kind: 'routed', route: 'admit' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = liveSuperAgentClient('http://127.0.0.1:9', generate)

    expect(client.createOperationId()).toBe(operationId)
    await client.send(operationId, 'Route once')

    expect(generate).toHaveBeenCalledOnce()
    expect(recordedCall(fetchMock)[1].body).toBe(
      `{"operation_id":"${operationId}","text":"Route once"}`,
    )
  })

  it('reads an archived task open without hiding the conversation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ view: 'closed_once' })))
    const client = liveSuperAgentClient('http://127.0.0.1:9')

    await expect(client.openDetail('task-1')).resolves.toEqual({ view: 'closed_once' })
    vi.unstubAllGlobals()
  })

  it('loads the sidebar from the daemon origin without a provider key', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ rows: [ROW], API_KEY: 'sk-SECRET' }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeSocket)
    const client = liveSuperAgentClient('http://127.0.0.1:9')
    const sidebar = await client.sidebar()
    const [url, init] = recordedCall(fetchMock)
    expect(String(url)).toBe('http://127.0.0.1:9/api/super-agent/sidebar')
    expect(init.credentials).toBe('same-origin')
    expect(JSON.stringify(init.headers)).not.toContain('API_KEY')
    expect(JSON.stringify(init)).not.toContain('BASE_URL')
    expect(sidebar.rows).toEqual([ROW])
    expect(JSON.stringify(sidebar)).not.toContain('sk-SECRET')
    expect(JSON.stringify(sidebar)).not.toContain('API_KEY')
  })

  it.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s sidebar counts', async (_label, invalidCount) => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        rows: [{ ...ROW, criteria_done: invalidCount }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = liveSuperAgentClient('http://127.0.0.1:9')

    await expect(client.sidebar()).rejects.toMatchObject({
      name: 'SuperAgentRequestError',
      code: 'request_failed',
    })
  })

  it.each([0, Number.MAX_SAFE_INTEGER])('accepts the safe sidebar count boundary %s', async (count) => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        rows: [{
          ...ROW,
          elapsed_ms: count,
          criteria_done: count,
          criteria_total: count,
        }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = liveSuperAgentClient('http://127.0.0.1:9')

    await expect(client.sidebar()).resolves.toEqual({
      rows: [{
        ...ROW,
        elapsed_ms: count,
        criteria_done: count,
        criteria_total: count,
      }],
      approvals: [],
    })
  })

  it('reads a pending approval and skips a row the model could have shaped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          rows: [ROW],
          approvals: [
            {
              approval_id: '41',
              task_id: 'task-1',
              kind: 'login',
              taint: 'untrusted',
              grant_text: 'Sign in to the service this task needs',
              reason: 'This task is waiting for you to sign in.',
              created_at: 10,
              expires_at: 20,
            },
            { approval_id: 'bad', kind: 'invented' },
          ],
        }),
      ),
    )
    const sidebar = await liveSuperAgentClient('http://127.0.0.1:9').sidebar()
    expect(sidebar.approvals).toEqual([
      {
        approval_id: '41',
        task_id: 'task-1',
        kind: 'login',
        taint: 'untrusted',
        grant_text: 'Sign in to the service this task needs',
        reason: 'This task is waiting for you to sign in.',
        created_at: 10,
        expires_at: 20,
      },
    ])
  })

  it.each([
    ['blank', ''],
    ['control', 'task\u0000id'],
    ['slash', 'task/id'],
    ['backslash', 'task\\id'],
    ['overlong', 'x'.repeat(201)],
  ])('rejects malformed sidebar task ids: %s', async (_label, taskId) => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        rows: [{ ...ROW, task_id: taskId }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = liveSuperAgentClient('http://127.0.0.1:9')

    await expect(client.sidebar()).rejects.toMatchObject({
      name: 'SuperAgentRequestError',
      code: 'request_failed',
    })
  })

  it('parses an admitted routing failure without treating it as transport rejection', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          admitted: 'admit',
          admission: 'admitted',
          outcome: { kind: 'routed', route: 'admit' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            admission: 'admitted',
            outcome: {
              kind: 'routing_failed',
              reason: 'model_provider_unavailable',
              detail: 'sk-SECRET BASE_URL',
            },
          },
          200,
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const client = liveSuperAgentClient('http://127.0.0.1:9')
    await expect(send(client, 'Add a pin control')).resolves.toEqual({
      admission: 'admitted',
      message_id: null,
      outcome: { kind: 'routed', route: 'admit' },
    })
    const [url, init] = recordedCall(fetchMock)
    expect(String(url)).toBe('http://127.0.0.1:9/api/super-agent/messages')
    expect(JSON.parse(String(init.body))).toEqual({
      operation_id: expect.any(String),
      text: 'Add a pin control',
    })
    expect(init.credentials).toBe('same-origin')
    expect(String(init.body)).not.toContain('API_KEY')
    const admittedFailure = await send(client, 'again')
    expect(admittedFailure).toEqual({
      admission: 'admitted',
      message_id: null,
      outcome: {
        kind: 'routing_failed',
        reason: 'model_provider_unavailable',
      },
    })
    expect(JSON.stringify(admittedFailure)).not.toContain('sk-SECRET')
    expect(JSON.stringify(admittedFailure)).not.toContain('BASE_URL')
  })

  it('rejects a pre-admission store failure with stable safe copy', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ error: 'task_store_unavailable', detail: 'sk-SECRET BASE_URL' }, 500),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = liveSuperAgentClient('http://127.0.0.1:9')

    const error = await send(client, 'Retryable draft').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(SuperAgentRequestError)
    expect((error as Error).message).toBe('The task store is unavailable.')
    expect((error as Error).message).not.toContain('sk-SECRET')
    expect((error as Error).message).not.toContain('BASE_URL')
  })

  it.each(['constructor', 'toString', '__proto__'])(
    'treats inherited error name %s as generic',
    async (inheritedName) => {
      const direct = new SuperAgentRequestError(inheritedName)
      expect(direct.code).toBe('request_failed')
      expect(direct.message).toBe('The request failed.')

      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse({ error: inheritedName }, 500),
      )
      vi.stubGlobal('fetch', fetchMock)
      const client = liveSuperAgentClient('http://127.0.0.1:9')
      await expect(send(client, 'Do not trust prototypes')).rejects.toMatchObject({
        code: 'request_failed',
        message: 'The request failed.',
      })
    },
  )

  it('recognizes unknown admitted outcomes without trusting their fields', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        admission: 'admitted',
        message_id: 'm-accepted',
        outcome: {
          kind: 'future_server_outcome',
          detail: 'provider=https://private.invalid token=sk-SECRET',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = liveSuperAgentClient('http://127.0.0.1:9')

    const result = await send(client, 'Accepted once')

    expect(result).toEqual({
      admission: 'admitted',
      message_id: 'm-accepted',
      outcome: { kind: 'unknown_outcome' },
    })
    expect(JSON.stringify(result)).not.toContain('private.invalid')
    expect(JSON.stringify(result)).not.toContain('sk-SECRET')
  })

  it('keeps malformed success without admitted syntax retryable', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        outcome: { kind: 'future_server_outcome' },
        message_id: 'm-not-admitted',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = liveSuperAgentClient('http://127.0.0.1:9')

    await expect(send(client, 'Not admitted')).rejects.toMatchObject({
      name: 'SuperAgentRequestError',
      code: 'request_failed',
    })
  })

  it('projects websocket sidebar frames and ignores secret fields', () => {
    vi.stubGlobal('WebSocket', FakeSocket)
    FakeSocket.instances = []
    const client = liveSuperAgentClient('http://127.0.0.1:9')
    const seen: unknown[] = []
    const stop = client.subscribeSidebar?.((rows) => {
      seen.push(rows)
    })
    expect(FakeSocket.instances[0]?.url).toBe('ws://127.0.0.1:9/api/super-agent/ws')
    FakeSocket.instances[0]?.emit(JSON.stringify({ rows: [{ ...ROW, API_KEY: 'sk-SECRET' }], BASE_URL: 'http://secret' }))
    FakeSocket.instances[0]?.emit('not-json sk-SECRET')
    expect(seen).toEqual([[ROW]])
    expect(JSON.stringify(seen)).not.toContain('sk-SECRET')
    expect(JSON.stringify(seen)).not.toContain('BASE_URL')
    stop?.()
  })

  it('reports reconnecting after the sidebar socket closes and connected when it opens', () => {
    const harness = socketHarness()
    const factory = liveSuperAgentClient as ReviewedLiveFactory
    const client = factory('http://127.0.0.1:9', undefined, harness.ports)
    const seen: string[] = []
    const stopRows = client.subscribeSidebar?.(() => undefined)
    const stopLink = client.subscribeConnection?.((snapshot) => {
      seen.push(`${snapshot.phase}:${snapshot.origin}`)
    })
    expect(seen).toEqual(['connected:http://127.0.0.1:9'])
    harness.sockets[0]?.emitClose()
    expect(seen.at(-1)).toBe('reconnecting:http://127.0.0.1:9')
    harness.runNext()
    harness.sockets[1]?.emitOpen()
    expect(seen.at(-1)).toBe('connected:http://127.0.0.1:9')
    stopLink?.()
    stopRows?.()
  })

  it('reconnects once after close with the original websocket URL', () => {
    const harness = socketHarness()
    const factory = liveSuperAgentClient as ReviewedLiveFactory
    const client = factory(
      'http://127.0.0.1:9',
      undefined,
      harness.ports,
    )
    const stop = client.subscribeSidebar?.(() => undefined)
    expect(harness.sockets).toHaveLength(1)
    harness.sockets[0]?.emitOpen()

    harness.sockets[0]?.emitClose()
    expect(harness.scheduled.filter((item) => !item.cancelled)).toHaveLength(1)
    expect(harness.scheduled[0]?.delay_ms).toBe(10)
    harness.runNext()

    expect(harness.sockets).toHaveLength(2)
    expect(harness.sockets[1]?.url).toBe('ws://127.0.0.1:9/api/super-agent/ws')
    stop?.()
  })

  it('coalesces duplicate websocket close and error events', () => {
    const harness = socketHarness()
    const factory = liveSuperAgentClient as ReviewedLiveFactory
    const client = factory('http://127.0.0.1:9', undefined, harness.ports)
    const stop = client.subscribeSidebar?.(() => undefined)

    harness.sockets[0]?.emitError()
    harness.sockets[0]?.emitClose()
    harness.sockets[0]?.emitClose()

    expect(harness.scheduled.filter((item) => !item.cancelled)).toHaveLength(1)
    expect(harness.sockets[0]?.closed).toBe(true)
    stop?.()
  })

  it('uses bounded websocket reconnect backoff until a socket opens', () => {
    const harness = socketHarness()
    const factory = liveSuperAgentClient as ReviewedLiveFactory
    const client = factory('http://127.0.0.1:9', undefined, harness.ports)
    const stop = client.subscribeSidebar?.(() => undefined)

    harness.sockets[0]?.emitClose()
    harness.runNext()
    harness.sockets[1]?.emitClose()
    harness.runNext()
    harness.sockets[2]?.emitClose()

    expect(harness.scheduled.map((item) => item.delay_ms)).toEqual([10, 20, 20])
    stop?.()
  })

  it('cancels websocket reconnect when the last listener unsubscribes', () => {
    const harness = socketHarness()
    const factory = liveSuperAgentClient as ReviewedLiveFactory
    const client = factory('http://127.0.0.1:9', undefined, harness.ports)
    const stop = client.subscribeSidebar?.(() => undefined)
    harness.sockets[0]?.emitClose()

    stop?.()
    harness.runNext()

    expect(harness.sockets).toHaveLength(1)
    expect(harness.scheduled.every((item) => item.cancelled)).toBe(true)
  })

  it('dispose cancels websocket reconnect and prevents later subscriptions', () => {
    const harness = socketHarness()
    const factory = liveSuperAgentClient as ReviewedLiveFactory
    const client = factory('http://127.0.0.1:9', undefined, harness.ports)
    client.subscribeSidebar?.(() => undefined)
    harness.sockets[0]?.emitClose()

    expect(typeof client.dispose).toBe('function')
    client.dispose?.()
    harness.runNext()
    client.subscribeSidebar?.(() => undefined)

    expect(harness.sockets).toHaveLength(1)
    expect(harness.scheduled.every((item) => item.cancelled)).toBe(true)
  })
})

describe('live inspector', () => {
  it('reads stored turns and leaves a missing cache percent empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          turns: [
            {
              ordinal: 1,
              message_id: 'm-1',
              cached_percent: null,
              slots: [
                {
                  ordinal: 1,
                  label: 'Route tools',
                  bytes: 4,
                  residence: 'unreported',
                  detail: '1 schemas',
                },
              ],
              recall: [],
              thinking: null,
              route: 'spawn_task',
              reply: 'Dispatched.',
              trace: [{ kind: 'route', text: 'spawn_task' }],
            },
          ],
        }),
      ),
    )
    const snapshot = await liveSuperAgentClient('http://127.0.0.1:4178').inspector?.()
    expect(snapshot?.turns[0]?.cached_percent).toBeNull()
    expect(snapshot?.turns[0]?.slots[0]?.label).toBe('Route tools')
    expect(snapshot?.turns[0]?.route).toBe('spawn_task')
  })
})

describe('selectSuperAgentClient', () => {
  it('keeps tests on a fresh fixture and uses the page origin outside tests', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ rows: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const fixture = selectSuperAgentClient('test', 'http://127.0.0.1:9')
    const sidebar = await fixture.sidebar()
    expect(sidebar.rows[0]?.title).toBe('Pin control')
    expect(fetchMock).not.toHaveBeenCalled()
    const live = selectSuperAgentClient('production', 'http://127.0.0.1:4178')
    await live.sidebar()
    expect(String(recordedCall(fetchMock)[0])).toBe('http://127.0.0.1:4178/api/super-agent/sidebar')
  })

  it('renders the app with the fixture client once', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const view = render(createElement(App))
    expect(await screen.findByRole('heading', { name: 'Welcome to Maia' })).toBeInTheDocument()
    view.rerender(createElement(App))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
