import { fixtureSuperAgentClient } from '@/api/fixtureSuperAgent'
import { remoteCsrf } from '@/remote/csrf'
import {
  MODEL_PROVIDER_UNAVAILABLE_TEXT,
  ROUTE_UNREADABLE_TEXT,
} from '@/api/superAgentOutcome'
import type {
  AdmittedRouteName,
  MessageAdmissionResult,
  PinMark,
  InspectorSnapshot,
  InspectorTurn,
  RouterMessage,
  RoutingFailureReason,
  SidebarRow,
  SidebarSection,
  SubmissionOperationId,
  SuperAgentBackendScope,
  SuperAgentClient,
  TaskDetail,
  TaskPhaseName,
} from '@/api/superAgentTypes'

const ADMITTED: readonly AdmittedRouteName[] = ['admit', 'ask', 'refuse']
const PHASES: readonly TaskPhaseName[] = [
  'queued',
  'running',
  'waiting_for_user',
  'blocked',
  'failed',
  'completed',
  'cancelled',
  'abandoned',
]
const SECTIONS: readonly SidebarSection[] = ['needs_you', 'working', 'completed', 'pinned', 'archive']
const PINS: readonly PinMark[] = ['pinned', 'unpinned']
const MAX_TASK_ID_BYTES = 200

const ERROR_TEXT = {
  invalid_json: 'The message could not be read.',
  invalid_message: 'The message could not be read.',
  empty_message: 'Enter a message.',
  unsupported_media_type: 'The message could not be read.',
  payload_too_large: 'That message is too long.',
  model_provider_unavailable: MODEL_PROVIDER_UNAVAILABLE_TEXT,
  route_unreadable: ROUTE_UNREADABLE_TEXT,
  task_store_unavailable: 'The task store is unavailable.',
  session_unavailable: 'The session is unavailable.',
  unknown_task: 'That task is not available.',
  unknown_command: 'That command is not available.',
  command_rejected: 'That command was not applied.',
  invalid_pin: 'That pin was not applied.',
  invalid_view: 'That detail view was not applied.',
  detail_not_open: 'Open the detail before closing it.',
  unknown_route: 'That request is not available.',
  request_failed: 'The request failed.',
  invalid_operation_id: 'The message operation is invalid.',
  submission_conflict: 'That message operation conflicts with an earlier submission.',
} as const

type SuperAgentErrorCode = keyof typeof ERROR_TEXT

export class SuperAgentRequestError extends Error {
  readonly code: string

  constructor(code: string) {
    const known = knownErrorCode(code)
    super(ERROR_TEXT[known])
    this.name = 'SuperAgentRequestError'
    this.code = known
  }
}

export function selectSuperAgentClient(mode: string, origin: string): SuperAgentClient {
  if (mode === 'test') return fixtureSuperAgentClient()
  return liveSuperAgentClient(origin)
}

export interface LiveWebSocketPorts {
  connect(url: string): WebSocket
  schedule(delayMs: number, callback: () => void): unknown
  cancel(handle: unknown): void
  reconnect_delays_ms: readonly number[]
}

export function liveSuperAgentClient(
  origin: string,
  generateOperationId: () => SubmissionOperationId = browserOperationId,
  socketPorts: LiveWebSocketPorts = browserWebSocketPorts(),
): SuperAgentClient {
  const root = trimOrigin(origin)
  const listeners = new Set<(rows: SidebarRow[]) => void>()
  let socket: WebSocket | null = null
  let reconnectHandle: unknown | null = null
  let reconnectAttempt = 0
  let disposed = false

  function ensureSocket() {
    if (disposed || listeners.size === 0 || socket || reconnectHandle !== null) return
    let next: WebSocket
    try {
      next = socketPorts.connect(websocketUrl(root))
    } catch {
      scheduleReconnect()
      return
    }
    socket = next
    next.onopen = () => {
      if (socket === next) reconnectAttempt = 0
    }
    next.onmessage = (event) => {
      if (socket !== next) return
      if (typeof event.data !== 'string') return
      const sidebar = readSocket(event.data)
      if (!sidebar) return
      for (const listener of listeners) listener(sidebar.rows)
    }
    const disconnected = () => {
      if (socket === next) socket = null
      scheduleReconnect()
    }
    next.onerror = () => {
      if (socket === next) {
        socket = null
        next.close()
      }
      scheduleReconnect()
    }
    next.onclose = disconnected
  }

  function scheduleReconnect() {
    if (
      disposed ||
      listeners.size === 0 ||
      socket !== null ||
      reconnectHandle !== null
    ) {
      return
    }
    const delays = socketPorts.reconnect_delays_ms
    const index = Math.min(reconnectAttempt, Math.max(delays.length - 1, 0))
    const delay = delays[index] ?? 1_000
    reconnectAttempt = Math.min(reconnectAttempt + 1, Number.MAX_SAFE_INTEGER)
    reconnectHandle = socketPorts.schedule(delay, () => {
      reconnectHandle = null
      ensureSocket()
    })
  }

  function stopSocket() {
    if (reconnectHandle !== null) {
      socketPorts.cancel(reconnectHandle)
      reconnectHandle = null
    }
    const current = socket
    socket = null
    reconnectAttempt = 0
    current?.close()
  }

  return {
    dataSource: 'live',
    backendScope: `live:${root}` as SuperAgentBackendScope,
    createOperationId: generateOperationId,
    sidebar: () => readJson(root, '/api/super-agent/sidebar', undefined, readSidebar),
    transcript: () => readJson(root, '/api/super-agent/transcript', undefined, readTranscript),
    inspector: () => readJson(root, '/api/super-agent/inspector', undefined, readInspector),
    task: (taskId) =>
      readJson(root, `/api/super-agent/tasks/${encodeURIComponent(taskId)}`, undefined, readDetail),
    send: (operationId, text) =>
      readJson(
        root,
        '/api/super-agent/messages',
        {
          method: 'POST',
          body: JSON.stringify({ operation_id: operationId, text }),
        },
        readMessageAdmission,
      ),
    pin: (taskId, pin) =>
      readJson(
        root,
        `/api/super-agent/tasks/${encodeURIComponent(taskId)}/pin`,
        { method: 'POST', body: JSON.stringify({ pin }) },
        readPin,
      ),
    openDetail: (taskId) =>
      readJson(
        root,
        `/api/super-agent/tasks/${encodeURIComponent(taskId)}/detail`,
        { method: 'POST', body: JSON.stringify({ view: 'open' }) },
        readOpen,
      ),
    closeDetail: (taskId) =>
      readJson(
        root,
        `/api/super-agent/tasks/${encodeURIComponent(taskId)}/detail`,
        { method: 'POST', body: JSON.stringify({ view: 'closed_once' }) },
        readClose,
      ),
    insertReference: (taskId) =>
      readJson(
        root,
        `/api/super-agent/tasks/${encodeURIComponent(taskId)}/reference`,
        { method: 'POST', body: JSON.stringify({}) },
        readReference,
      ),
    hostCommand: (command) =>
      readJson(
        root,
        '/api/super-agent/host-command',
        { method: 'POST', body: JSON.stringify(command) },
        readPhase,
      ),
    subscribeSidebar(onRows) {
      if (disposed) return () => undefined
      listeners.add(onRows)
      ensureSocket()
      return () => {
        listeners.delete(onRows)
        if (listeners.size === 0) stopSocket()
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
      stopSocket()
    },
  }
}

function browserWebSocketPorts(): LiveWebSocketPorts {
  return {
    connect: (url) => new WebSocket(url),
    schedule: (delayMs, callback) => globalThis.setTimeout(callback, delayMs),
    cancel: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    reconnect_delays_ms: [250, 500, 1_000, 2_000, 5_000],
  }
}

function browserOperationId(): SubmissionOperationId {
  return globalThis.crypto.randomUUID() as SubmissionOperationId
}

function trimOrigin(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}

function websocketUrl(origin: string): string {
  const url = new URL('/api/super-agent/ws', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

async function readJson<T>(
  origin: string,
  path: string,
  init: RequestInit | undefined,
  read: (value: unknown) => T | null,
): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('accept', 'application/json')
  if (init?.body) headers.set('content-type', 'application/json')
  const method = (init?.method ?? 'GET').toUpperCase()
  const token = method === 'GET' || method === 'HEAD' ? null : remoteCsrf()
  if (token) headers.set('x-csrf-token', token)
  const response = await fetch(new URL(path, origin), {
    ...init,
    credentials: 'same-origin',
    headers,
  })
  if (!response.ok) return fail(response)
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new SuperAgentRequestError('request_failed')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new SuperAgentRequestError('request_failed')
  }
  const value = read(body)
  if (!value) throw new SuperAgentRequestError('request_failed')
  return value
}

async function fail(response: Response): Promise<never> {
  let code = 'request_failed'
  try {
    const body: unknown = await response.json()
    if (isRecord(body) && typeof body.error === 'string') {
      code = knownErrorCode(body.error)
    }
  } catch {
    code = 'request_failed'
  }
  throw new SuperAgentRequestError(code)
}

function readSocket(data: string): { rows: SidebarRow[] } | null {
  try {
    return readSidebar(JSON.parse(data) as unknown)
  } catch {
    return null
  }
}

function readSidebar(value: unknown): { rows: SidebarRow[] } | null {
  if (!isRecord(value) || !Array.isArray(value.rows)) return null
  const rows: SidebarRow[] = []
  for (const row of value.rows) {
    const read = readRow(row)
    if (!read) return null
    rows.push(read)
  }
  return { rows }
}

function readRow(value: unknown): SidebarRow | null {
  if (!isRecord(value)) return null
  if (!isTaskId(value.task_id) || typeof value.title !== 'string') return null
  if (typeof value.summary !== 'string') return null
  if (!isSection(value.section) || !isPhase(value.phase)) return null
  if (!isCount(value.elapsed_ms) || !isCount(value.criteria_done) || !isCount(value.criteria_total)) {
    return null
  }
  if (!Array.isArray(value.children)) return null
  const children: SidebarRow[] = []
  for (const child of value.children) {
    const read = readRow(child)
    if (!read) return null
    children.push(read)
  }
  return {
    task_id: value.task_id,
    title: value.title,
    section: value.section,
    phase: value.phase,
    summary: value.summary,
    elapsed_ms: value.elapsed_ms,
    criteria_done: value.criteria_done,
    criteria_total: value.criteria_total,
    children,
  }
}

function readTranscript(value: unknown): { messages: RouterMessage[] } | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null
  const messages: RouterMessage[] = []
  for (const message of value.messages) {
    if (!isRecord(message)) return null
    if (typeof message.message_id !== 'string' || typeof message.text !== 'string') return null
    if (message.role !== 'owner' && message.role !== 'router') return null
    const thinking = typeof message.thinking === 'string' && message.thinking.length > 0 ? message.thinking : undefined
    const route = typeof message.route === 'string' && message.route.length > 0 ? message.route : undefined
    messages.push({ message_id: message.message_id, role: message.role, text: message.text, thinking, route })
  }
  return { messages }
}

function readInspector(value: unknown): InspectorSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.turns)) return null
  const turns: InspectorTurn[] = []
  for (const turn of value.turns) {
    const read = readInspectorTurn(turn)
    if (!read) return null
    turns.push(read)
  }
  return { turns }
}

function readInspectorTurn(value: unknown): InspectorTurn | null {
  if (!isRecord(value)) return null
  if (!isCount(value.ordinal) || typeof value.message_id !== 'string' || value.message_id.length === 0) {
    return null
  }
  if (value.cached_percent !== null && !isPercent(value.cached_percent)) return null
  if (typeof value.reply !== 'string') return null
  if (value.thinking !== null && typeof value.thinking !== 'string') return null
  if (value.route !== null && typeof value.route !== 'string') return null
  if (!Array.isArray(value.slots) || !Array.isArray(value.recall) || !Array.isArray(value.trace)) {
    return null
  }
  const slots = mapOne(value.slots, readInspectorSlot)
  const recall = mapOne(value.recall, readRecallItem)
  const trace = mapOne(value.trace, readTraceStep)
  if (!slots || !recall || !trace) return null
  return {
    ordinal: value.ordinal,
    message_id: value.message_id,
    cached_percent: value.cached_percent,
    slots,
    recall,
    thinking: value.thinking,
    route: value.route,
    reply: value.reply,
    trace,
  }
}

function readInspectorSlot(value: unknown) {
  if (!isRecord(value) || !isCount(value.ordinal) || typeof value.label !== 'string') return null
  if (!isCount(value.bytes) || !isResidence(value.residence) || typeof value.detail !== 'string') {
    return null
  }
  return {
    ordinal: value.ordinal,
    label: value.label,
    bytes: value.bytes,
    residence: value.residence,
    detail: value.detail,
  }
}

function readRecallItem(value: unknown): { id: string; kind: 'claim' | 'fact'; sentence: string; score: number } | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.sentence !== 'string') return null
  const kind = value.kind === 'claim' ? 'claim' : value.kind === 'fact' ? 'fact' : null
  if (!kind) return null
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) return null
  return { id: value.id, kind, sentence: value.sentence, score: value.score }
}

function readTraceStep(value: unknown): { kind: 'reasoning' | 'route' | 'reply'; text: string } | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null
  const kind = value.kind === 'reasoning' ? 'reasoning' : value.kind === 'route' ? 'route' : value.kind === 'reply' ? 'reply' : null
  if (!kind) return null
  return { kind, text: value.text }
}

function mapOne<T>(values: unknown[], read: (value: unknown) => T | null): T[] | null {
  const mapped: T[] = []
  for (const value of values) {
    const item = read(value)
    if (!item) return null
    mapped.push(item)
  }
  return mapped
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
}

function isResidence(value: unknown): value is 'cached' | 'uncached' | 'unreported' {
  return value === 'cached' || value === 'uncached' || value === 'unreported'
}

function readDetail(value: unknown): TaskDetail | null {
  if (!isRecord(value)) return null
  if (!isTaskId(value.task_id) || typeof value.title !== 'string') return null
  if (typeof value.original_prompt !== 'string' || typeof value.acceptance_context !== 'string') {
    return null
  }
  if (!Array.isArray(value.transcript) || !Array.isArray(value.tool_events)) return null
  if (!Array.isArray(value.artifacts) || !Array.isArray(value.attempts)) return null
  if (!Array.isArray(value.decisions) || !Array.isArray(value.criteria)) return null
  if (!Array.isArray(value.helpers)) return null
  const transcript = mapAll(value.transcript, readTranscriptLine)
  const toolEvents = mapAll(value.tool_events, readTool)
  const artifacts = mapAll(value.artifacts, readArtifact)
  const attempts = mapAll(value.attempts, readAttempt)
  const decisions = mapAll(value.decisions, readDecision)
  const criteria = mapAll(value.criteria, readCriterion)
  const helpers = mapAll(value.helpers, readHelper)
  if (!transcript || !toolEvents || !artifacts || !attempts || !decisions || !criteria || !helpers) {
    return null
  }
  return {
    task_id: value.task_id,
    title: value.title,
    original_prompt: value.original_prompt,
    acceptance_context: value.acceptance_context,
    transcript,
    tool_events: toolEvents,
    artifacts,
    attempts,
    decisions,
    criteria,
    helpers,
  }
}

function mapAll<T>(values: unknown[], read: (value: unknown) => T[]): T[] | null {
  const mapped: T[] = []
  for (const value of values) {
    const item = read(value)
    if (item.length !== 1) return null
    const first = item[0]
    if (!first) return null
    mapped.push(first)
  }
  return mapped
}

function readTranscriptLine(value: unknown): TaskDetail['transcript'] {
  if (!isRecord(value)) return []
  if (typeof value.id !== 'string' || typeof value.author !== 'string' || typeof value.text !== 'string') {
    return []
  }
  return [{ id: value.id, author: value.author, text: value.text }]
}

function readTool(value: unknown): TaskDetail['tool_events'] {
  if (!isRecord(value)) return []
  if (typeof value.call_id !== 'string' || typeof value.name !== 'string' || typeof value.summary !== 'string') {
    return []
  }
  return [{ call_id: value.call_id, name: value.name, summary: value.summary }]
}

function readArtifact(value: unknown): TaskDetail['artifacts'] {
  if (!isRecord(value)) return []
  if (typeof value.artifact_id !== 'string' || typeof value.label !== 'string') return []
  return [{ artifact_id: value.artifact_id, label: value.label }]
}

function readAttempt(value: unknown): TaskDetail['attempts'] {
  if (!isRecord(value)) return []
  if (typeof value.attempt_id !== 'string' || typeof value.summary !== 'string' || !isPhase(value.phase)) {
    return []
  }
  return [{ attempt_id: value.attempt_id, phase: value.phase, summary: value.summary }]
}

function readDecision(value: unknown): TaskDetail['decisions'] {
  if (!isRecord(value)) return []
  if (typeof value.decision_id !== 'string' || typeof value.text !== 'string') return []
  return [{ decision_id: value.decision_id, text: value.text }]
}

function readCriterion(value: unknown): TaskDetail['criteria'] {
  if (!isRecord(value)) return []
  if (typeof value.criterion_id !== 'string' || typeof value.text !== 'string') return []
  if (
    value.mark !== 'pending' &&
    value.mark !== 'satisfied' &&
    value.mark !== 'waived' &&
    value.mark !== 'inapplicable'
  ) {
    return []
  }
  return [{ criterion_id: value.criterion_id, text: value.text, mark: value.mark }]
}

function readHelper(value: unknown): TaskDetail['helpers'] {
  if (!isRecord(value)) return []
  if (!isTaskId(value.task_id) || typeof value.title !== 'string') return []
  return [{ task_id: value.task_id, title: value.title }]
}

function readMessageAdmission(value: unknown): MessageAdmissionResult | null {
  if (!isRecord(value)) return null
  if (value.admission === 'admitted') {
    const messageId = typeof value.message_id === 'string' ? value.message_id : null
    if (isRecord(value.outcome) && value.outcome.kind === 'routed' && isAdmitted(value.outcome.route)) {
      return {
        admission: 'admitted',
        message_id: messageId,
        outcome: { kind: 'routed', route: value.outcome.route },
      }
    }
    if (
      isRecord(value.outcome) &&
      value.outcome.kind === 'routing_failed' &&
      isRoutingFailureReason(value.outcome.reason)
    ) {
      return {
        admission: 'admitted',
        message_id: messageId,
        outcome: {
          kind: 'routing_failed',
          reason: value.outcome.reason,
        },
      }
    }
    if (
      isRecord(value.outcome) &&
      value.outcome.kind === 'processing_failed' &&
      value.outcome.reason === 'processing_unavailable'
    ) {
      return {
        admission: 'admitted',
        message_id: messageId,
        outcome: {
          kind: 'processing_failed',
          reason: 'processing_unavailable',
        },
      }
    }
    if (
      isRecord(value.outcome) &&
      value.outcome.kind === 'processing_pending' &&
      value.outcome.reason === 'processing_pending'
    ) {
      return {
        admission: 'admitted',
        message_id: messageId,
        outcome: {
          kind: 'processing_pending',
          reason: 'processing_pending',
        },
      }
    }
    return {
      admission: 'admitted',
      message_id: messageId,
      outcome: { kind: 'unknown_outcome' },
    }
  }
  if (!isAdmitted(value.admitted)) return null
  return {
    admission: 'admitted',
    message_id: null,
    outcome: { kind: 'routed', route: value.admitted },
  }
}

function readPin(value: unknown): { pin: PinMark } | null {
  if (!isRecord(value) || !isPin(value.pin)) return null
  return { pin: value.pin }
}

function readOpen(value: unknown): { view: 'open' } | null {
  if (!isRecord(value) || value.view !== 'open') return null
  return { view: 'open' }
}

function readClose(value: unknown): { view: 'closed_once' } | null {
  if (!isRecord(value) || value.view !== 'closed_once') return null
  return { view: 'closed_once' }
}

function readReference(value: unknown): { composer_insert: string } | null {
  if (!isRecord(value) || typeof value.composer_insert !== 'string') return null
  return { composer_insert: value.composer_insert }
}

function readPhase(value: unknown): { phase: TaskPhaseName } | null {
  if (!isRecord(value) || !isPhase(value.phase)) return null
  return { phase: value.phase }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function knownErrorCode(value: string): SuperAgentErrorCode {
  return Object.hasOwn(ERROR_TEXT, value)
    ? (value as SuperAgentErrorCode)
    : 'request_failed'
}

function isTaskId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).length <= MAX_TASK_ID_BYTES &&
    !/[\p{Cc}/\\]/u.test(value)
  )
}

function isAdmitted(value: unknown): value is AdmittedRouteName {
  return typeof value === 'string' && ADMITTED.some((item) => item === value)
}

function isRoutingFailureReason(value: unknown): value is RoutingFailureReason {
  return value === 'model_provider_unavailable' || value === 'route_unreadable'
}

function isPhase(value: unknown): value is TaskPhaseName {
  return typeof value === 'string' && PHASES.some((item) => item === value)
}

function isSection(value: unknown): value is SidebarSection {
  return typeof value === 'string' && SECTIONS.some((item) => item === value)
}

function isPin(value: unknown): value is PinMark {
  return typeof value === 'string' && PINS.some((item) => item === value)
}
