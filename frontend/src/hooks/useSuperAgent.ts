import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  ActivityLine,
  ComposerNotice,
  HostCommand,
  LiveApproval,
  OutgoingMessage,
  PinMark,
  RouterMessage,
  SidebarRow,
  SubmissionOperationId,
  SuperAgentBackendScope,
  SuperAgentClient,
  TaskDetail,
  TranscriptState,
} from '@/api/superAgentTypes'
import { SuperAgentRequestError } from '@/api/liveSuperAgent'
import { pinMarkFor } from '@/api/superAgentFormat'
import { admissionOutcomeText, PROCESSING_PENDING_TEXT } from '@/api/superAgentOutcome'
import {
  createSuperAgentState,
  reduceSuperAgentState,
  type AdmissionState,
  type ClientActivationId,
  type ClientSessionId,
  type RouterAnnouncement,
  type SendOperation,
  type SendOperationToken,
  type SuperAgentEvent,
  type TranscriptAnnouncementMode,
  type TranscriptLoadPurpose,
} from '@/state/superAgentSession'

const TRANSCRIPT_LOAD_ERROR = 'The conversation could not be loaded.'
const TRANSCRIPT_REFRESH_ERROR = 'The conversation could not be refreshed.'
const TRANSCRIPT_REFRESH_NOTICE = 'Message sent. Refresh the conversation to see the latest reply.'
const SEND_FAILED_TEXT = 'Message failed. Try again.'
const SEND_WATCH_MS = 2_000
const SEND_GIVE_UP_MS = 150_000
const SEND_TRANSCRIPT_PROBE_MS = 5_000

function detailAlreadyOpen(error: unknown): boolean {
  return error instanceof SuperAgentRequestError && error.code === 'command_rejected'
}

type TranscriptLoadResult =
  | { kind: 'loaded'; messages: readonly RouterMessage[] }
  | { kind: 'failed' }
  | { kind: 'stale' }

declare const shellActionKeyBrand: unique symbol
type ShellActionKey = string & {
  readonly [shellActionKeyBrand]: 'ShellActionKey'
}

type ShellActionIdentity =
  | { kind: 'close_detail'; task_id: string }
  | { kind: 'quote'; task_id: string }
  | { kind: 'pin'; task_id: string; pin: PinMark }
  | { kind: 'host'; command: HostCommand }

interface ShellActionToken {
  key: ShellActionKey
  owner: symbol
}

const SubmissionErrorDisposition = {
  RetainAmbiguous: 'retain_ambiguous',
  DiscardPreAdmission: 'discard_pre_admission',
} as const
type SubmissionErrorDisposition =
  (typeof SubmissionErrorDisposition)[keyof typeof SubmissionErrorDisposition]

const PROVEN_PRE_ADMISSION_ERRORS: ReadonlySet<string> = new Set([
  'invalid_json',
  'invalid_message',
  'invalid_operation_id',
  'empty_message',
  'unsupported_media_type',
  'payload_too_large',
  'task_store_unavailable',
  'submission_conflict',
])

interface ClientSession {
  id: ClientSessionId
  client: SuperAgentClient
  initial_activation: ClientActivationId
}

interface ClientActivation {
  id: ClientActivationId
  session: ClientSession
  controller: AbortController
  next_sidebar_request: () => number
  next_transcript_request: () => number
  next_detail_request: (
    purpose: 'open' | 'refresh',
    taskId: string,
  ) => { request_id: number; purpose: 'open' | 'refresh'; task_id: string }
  is_detail_owner: (request: {
    request_id: number
    purpose: 'open' | 'refresh'
    task_id: string
  }) => boolean
  select_task: (taskId: string | null) => void
  selected_task: () => string | null
  send_owner: () => SendOperationToken | null
  owns_send: (token: SendOperationToken) => boolean
  try_start_send: () => SendOperationToken | null
  finish_send: (token: SendOperationToken) => void
  try_start_shell_action: (key: ShellActionKey) => ShellActionToken | null
  finish_shell_action: (token: ShellActionToken) => void
  dispose: () => void
}

interface SubmissionController {
  backend_scope: SuperAgentBackendScope
  submission_for: (
    text: string,
    generate: () => SubmissionOperationId,
  ) => {
    operation_id: SubmissionOperationId
    text: string
  }
  discard: (operationId: SubmissionOperationId) => void
  reconcile_text: (text: string) => void
  retained_text: () => string | null
}

function createClientSession(client: SuperAgentClient): ClientSession {
  return {
    id: Symbol('super-agent-session'),
    client,
    initial_activation: Symbol('super-agent-pending-activation'),
  }
}

function createClientActivation(session: ClientSession): ClientActivation {
  const controller = new AbortController()
  let sidebarRequest = 0
  let transcriptRequest = 0
  let detailRequest = 0
  let detailOwner: {
    request_id: number
    purpose: 'open' | 'refresh'
    task_id: string
  } | null = null
  let selectedTask: string | null = null
  const sendOwners = new Set<SendOperationToken>()
  let sendOwner: SendOperationToken | null = null
  const shellActionOwners = new Map<ShellActionKey, symbol>()
  return {
    id: Symbol('super-agent-activation'),
    session,
    controller,
    next_sidebar_request: () => ++sidebarRequest,
    next_transcript_request: () => ++transcriptRequest,
    next_detail_request: (purpose, taskId) => {
      const request = { request_id: ++detailRequest, purpose, task_id: taskId }
      detailOwner = request
      if (purpose === 'open') selectedTask = taskId
      return request
    },
    is_detail_owner: (request) =>
      detailOwner?.request_id === request.request_id &&
      detailOwner.purpose === request.purpose &&
      detailOwner.task_id === request.task_id &&
      selectedTask === request.task_id,
    select_task: (taskId) => {
      selectedTask = taskId
      if (taskId === null || detailOwner?.task_id !== taskId) detailOwner = null
    },
    selected_task: () => selectedTask,
    send_owner: () => sendOwner,
    owns_send: (token) => sendOwners.has(token),
    try_start_send: () => {
      sendOwner = Symbol('super-agent-send')
      sendOwners.add(sendOwner)
      return sendOwner
    },
    finish_send: (token) => {
      sendOwners.delete(token)
      if (sendOwner === token) sendOwner = null
    },
    try_start_shell_action: (key) => {
      if (shellActionOwners.has(key)) return null
      const owner = Symbol('super-agent-shell-action')
      shellActionOwners.set(key, owner)
      return { key, owner }
    },
    finish_shell_action: (token) => {
      if (shellActionOwners.get(token.key) === token.owner) {
        shellActionOwners.delete(token.key)
      }
    },
    dispose: () => {
      shellActionOwners.clear()
      sendOwners.clear()
      sendOwner = null
      detailOwner = null
      controller.abort()
    },
  }
}

function createSubmissionController(
  backendScope: SuperAgentBackendScope,
): SubmissionController {
  let owner: { operation_id: SubmissionOperationId; text: string } | null = null
  return {
    backend_scope: backendScope,
    submission_for: (text, generate) => {
      if (owner?.text === text) return owner
      owner = { operation_id: generate(), text }
      return owner
    },
    discard: (operationId) => {
      if (owner?.operation_id === operationId) owner = null
    },
    reconcile_text: (text) => {
      if (owner && owner.text !== text) owner = null
    },
    retained_text: () => owner?.text ?? null,
  }
}

function isActiveActivation(activation: ClientActivation): boolean {
  return !activation.controller.signal.aborted
}

function transcriptIdentity(messages: readonly RouterMessage[]): string {
  let identity = ''
  for (const message of messages) {
    identity += message.message_id
    identity += '\n'
  }
  return identity
}

function storedOwnerSend(
  messages: readonly RouterMessage[],
  text: string,
): 'absent' | 'waiting' | 'answered' {
  let index = -1
  for (let cursor = 0; cursor < messages.length; cursor += 1) {
    const message = messages[cursor]
    if (message?.role === 'owner' && message.text === text) index = cursor
  }
  if (index < 0) return 'absent'
  const later = messages.slice(index + 1)
  return later.some((message) => message.role === 'router') ? 'answered' : 'waiting'
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

function submissionErrorDisposition(error: unknown): SubmissionErrorDisposition {
  if (
    error instanceof SuperAgentRequestError &&
    PROVEN_PRE_ADMISSION_ERRORS.has(error.code)
  ) {
    return SubmissionErrorDisposition.DiscardPreAdmission
  }
  return SubmissionErrorDisposition.RetainAmbiguous
}

function shellActionFailureText(error: unknown, fallback: string): string {
  return error instanceof SuperAgentRequestError ? error.message : fallback
}

function shellActionKey(identity: ShellActionIdentity): ShellActionKey {
  const task = (taskId: string) => `${taskId.length}:${taskId}`
  switch (identity.kind) {
    case 'close_detail':
      return `close_detail:${task(identity.task_id)}` as ShellActionKey
    case 'quote':
      return `quote:${task(identity.task_id)}` as ShellActionKey
    case 'pin':
      return `pin:${task(identity.task_id)}:${identity.pin}` as ShellActionKey
    case 'host': {
      const command = identity.command
      return command.command === 'stop_all'
        ? (`host:${command.command}` as ShellActionKey)
        : (`host:${command.command}:${task(command.task_id)}` as ShellActionKey)
    }
  }
}

function shellActionFailureEvent(
  activation: ClientActivation,
  error: unknown,
  fallback: string,
): SuperAgentEvent {
  return {
    type: 'shell_action_failed',
    session: activation.session.id,
    activation: activation.id,
    text: shellActionFailureText(error, fallback),
  }
}

export interface RouterBindings {
  messages: readonly RouterMessage[]
  transcriptState: TranscriptState
  admittedStatusMessageId: string | null
  admission: AdmissionState
  operation: SendOperation
  announcement: RouterAnnouncement | null
  draft: string
  notice: ComposerNotice
  detail: TaskDetail | null
  pinMark: PinMark
  setDraft: (draft: string) => void
  acknowledgeAnnouncement: (sequence: number) => void
  retryTranscript: () => Promise<void>
  submit: () => Promise<void>
  closeDetail: () => Promise<void>
  quote: (taskId: string) => Promise<void>
  pin: (taskId: string, pin: PinMark) => Promise<void>
  hostCommand: (command: HostCommand) => Promise<void>
  approvals: LiveApproval[]
  decideApproval: (approvalId: string, decision: 'approve' | 'deny') => Promise<void>
  canAttach: boolean
  stageAttachments: (files: readonly File[]) => Promise<void>
  outgoing: readonly OutgoingMessage[]
  retryOutgoing: (id: string) => void
  activity: readonly ActivityLine[]
}

export function useSuperAgent(client: SuperAgentClient): RouterBindings & {
  rows: SidebarRow[]
  openTask: (taskId: string) => Promise<void>
  outgoing: OutgoingMessage[]
  retryOutgoing: (id: string) => void
  activity: ActivityLine[]
} {
  const session = useMemo(() => createClientSession(client), [client])
  const submissionController = useMemo(
    () => createSubmissionController(client.backendScope),
    [client.backendScope],
  )
  const activeActivation = useRef<ClientActivation | null>(null)
  const closeSendWatch = useRef<(() => void) | null>(null)
  const pendingAttachmentIds = useRef<string[]>([])
  const queuedText = useRef<string | null>(null)
  const inflightText = useRef(new Map<string, SendOperationToken>())
  const [activity, setActivity] = useState<ActivityLine[]>([])
  const [outgoing, setOutgoing] = useState<OutgoingMessage[]>([])
  const outgoingRef = useRef(outgoing)
  outgoingRef.current = outgoing
  const submitRef = useRef<() => Promise<void>>(async () => undefined)
  const [storedState, dispatch] = useReducer(
    reduceSuperAgentState,
    session,
    (initialSession) =>
      createSuperAgentState(initialSession.id, initialSession.initial_activation),
  )
  const state =
    storedState.session === session.id
      ? storedState
      : createSuperAgentState(session.id, session.initial_activation)
  const draft =
    state.draft.length > 0
      ? state.draft
      : (submissionController.retained_text() ?? '')

  const refreshSidebar = useCallback(async (activation: ClientActivation) => {
    if (!isActiveActivation(activation)) return
    const requestId = activation.next_sidebar_request()
    dispatch({
      type: 'sidebar_started',
      session: activation.session.id,
      activation: activation.id,
      request_id: requestId,
    })
    try {
      const sidebar = await activation.session.client.sidebar()
      if (!isActiveActivation(activation)) return
      dispatch({
        type: 'sidebar_loaded',
        session: activation.session.id,
        activation: activation.id,
        request_id: requestId,
        rows: sidebar.rows,
        approvals: sidebar.approvals ?? [],
      })
    } catch {
      if (!isActiveActivation(activation)) return
      dispatch({
        type: 'sidebar_failed',
        session: activation.session.id,
        activation: activation.id,
        request_id: requestId,
      })
    }
  }, [])

  const loadTranscript = useCallback(
    async (
      activation: ClientActivation,
      purpose: TranscriptLoadPurpose,
      failureText: string,
      announcement: TranscriptAnnouncementMode = 'announce',
      admittedFailureText?: string,
    ): Promise<TranscriptLoadResult> => {
      if (!isActiveActivation(activation)) return { kind: 'stale' }
      const requestId = activation.next_transcript_request()
      dispatch({
        type: 'transcript_started',
        session: activation.session.id,
        activation: activation.id,
        request_id: requestId,
        purpose,
      })
      try {
        const transcript = await activation.session.client.transcript()
        setActivity(transcript.activity ?? [])
        if (!isActiveActivation(activation)) return { kind: 'stale' }
        dispatch({
          type: 'transcript_loaded',
          session: activation.session.id,
          activation: activation.id,
          request_id: requestId,
          purpose,
          announcement,
          admitted_failure_text: admittedFailureText,
          messages: transcript.messages,
        })
        return { kind: 'loaded', messages: transcript.messages }
      } catch {
        if (!isActiveActivation(activation)) return { kind: 'stale' }
        dispatch({
          type: 'transcript_failed',
          session: activation.session.id,
          activation: activation.id,
          request_id: requestId,
          purpose,
          text: failureText,
        })
        return { kind: 'failed' }
      }
    },
    [],
  )

  useEffect(() => {
    const activation = createClientActivation(session)
    activeActivation.current = activation
    dispatch({
      type: 'activation_started',
      session: session.id,
      activation: activation.id,
    })
    void refreshSidebar(activation)
    void loadTranscript(activation, 'hydrate', TRANSCRIPT_LOAD_ERROR, 'silent')
    const stopSubscription = session.client.subscribeSidebar?.((rows, approvals) => {
      if (!isActiveActivation(activation)) return
      const requestId = activation.next_sidebar_request()
      dispatch({
        type: 'sidebar_started',
        session: session.id,
        activation: activation.id,
        request_id: requestId,
      })
      dispatch({
        type: 'sidebar_loaded',
        session: session.id,
        activation: activation.id,
        request_id: requestId,
        rows,
        approvals: approvals ?? [],
      })
      void loadTranscript(activation, 'refresh', TRANSCRIPT_LOAD_ERROR, 'silent')
    })
    return () => {
      closeSendWatch.current?.()
      activation.dispose()
      if (activeActivation.current === activation) activeActivation.current = null
      stopSubscription?.()
    }
  }, [loadTranscript, refreshSidebar, session])

  const openTask = useCallback(
    async (taskId: string) => {
      const activation = activeActivation.current
      if (!activation || activation.session !== session || !isActiveActivation(activation)) return
      const request = activation.next_detail_request('open', taskId)
      dispatch({
        type: 'detail_started',
        session: session.id,
        activation: activation.id,
        ...request,
      })
      try {
        const next = await session.client.task(taskId)
        if (!isActiveActivation(activation) || !activation.is_detail_owner(request)) return
        try {
          await session.client.openDetail(taskId)
        } catch (error) {
          if (!detailAlreadyOpen(error)) throw error
        }
        if (!isActiveActivation(activation) || !activation.is_detail_owner(request)) return
        dispatch({
          type: 'detail_loaded',
          session: session.id,
          activation: activation.id,
          ...request,
          detail: next,
        })
        await refreshSidebar(activation)
      } catch {
        if (!isActiveActivation(activation) || !activation.is_detail_owner(request)) return
        activation.select_task(null)
        dispatch({
          type: 'detail_failed',
          session: session.id,
          activation: activation.id,
          ...request,
        })
      }
    },
    [refreshSidebar, session],
  )

  const closeDetail = useCallback(async () => {
    const activation = activeActivation.current
    const detail = state.detail.value
    if (!activation || activation.session !== session || !detail) return
    const token = activation.try_start_shell_action(
      shellActionKey({ kind: 'close_detail', task_id: detail.task_id }),
    )
    if (!token) return
    dispatch({
      type: 'notice_cleared',
      session: session.id,
      activation: activation.id,
    })
    try {
      await session.client.closeDetail(detail.task_id)
      if (
        !isActiveActivation(activation) ||
        activation.selected_task() !== detail.task_id
      ) {
        return
      }
      activation.select_task(null)
      dispatch({
        type: 'detail_closed',
        session: session.id,
        activation: activation.id,
        task_id: detail.task_id,
      })
      await refreshSidebar(activation)
    } catch (error) {
      if (isActiveActivation(activation)) {
        dispatch(shellActionFailureEvent(activation, error, 'The detail could not be closed. Try again.'))
      }
    } finally {
      activation.finish_shell_action(token)
    }
  }, [refreshSidebar, session, state.detail.value])

  const updateDraft = useCallback(
    (nextDraft: string) => {
      const activation = activeActivation.current
      if (!activation || activation.session !== session) {
        return
      }
      submissionController.reconcile_text(nextDraft.trim())
      dispatch({
        type: 'draft_changed',
        session: session.id,
        activation: activation.id,
        draft: nextDraft,
      })
    },
    [session, submissionController],
  )

  const quote = useCallback(
    async (taskId: string) => {
      const activation = activeActivation.current
      if (!activation || activation.session !== session) {
        return
      }
      const token = activation.try_start_shell_action(
        shellActionKey({ kind: 'quote', task_id: taskId }),
      )
      if (!token) return
      dispatch({
        type: 'notice_cleared',
        session: session.id,
        activation: activation.id,
      })
      try {
        const result = await session.client.insertReference(taskId)
        if (!isActiveActivation(activation) || activation.send_owner() !== null) return
        dispatch({
          type: 'draft_reference_inserted',
          session: session.id,
          activation: activation.id,
          insert: result.composer_insert,
        })
      } catch (error) {
        if (isActiveActivation(activation)) {
          dispatch(
            shellActionFailureEvent(
              activation,
              error,
              'The task reference could not be inserted. Try again.',
            ),
          )
        }
      } finally {
        activation.finish_shell_action(token)
      }
    },
    [session],
  )

  const pin = useCallback(
    async (taskId: string, mark: PinMark) => {
      const activation = activeActivation.current
      if (!activation || activation.session !== session) return
      const token = activation.try_start_shell_action(
        shellActionKey({ kind: 'pin', task_id: taskId, pin: mark }),
      )
      if (!token) return
      dispatch({
        type: 'notice_cleared',
        session: session.id,
        activation: activation.id,
      })
      try {
        await session.client.pin(taskId, mark)
        if (!isActiveActivation(activation)) return
        await refreshSidebar(activation)
      } catch (error) {
        if (isActiveActivation(activation)) {
          dispatch(shellActionFailureEvent(activation, error, 'The pin could not be changed. Try again.'))
        }
      } finally {
        activation.finish_shell_action(token)
      }
    },
    [refreshSidebar, session],
  )

  const hostCommand = useCallback(
    async (command: HostCommand) => {
      const activation = activeActivation.current
      if (!activation || activation.session !== session) return
      const token = activation.try_start_shell_action(
        shellActionKey({ kind: 'host', command }),
      )
      if (!token) return
      const selectedTask = state.detail.value?.task_id ?? null
      dispatch({
        type: 'notice_cleared',
        session: session.id,
        activation: activation.id,
      })
      try {
        await session.client.hostCommand(command)
        if (!isActiveActivation(activation)) return
        await refreshSidebar(activation)
        if (
          !isActiveActivation(activation) ||
          !selectedTask ||
          activation.selected_task() !== selectedTask
        ) {
          return
        }
        const request = activation.next_detail_request('refresh', selectedTask)
        dispatch({
          type: 'detail_started',
          session: session.id,
          activation: activation.id,
          ...request,
        })
        try {
          const nextDetail = await session.client.task(selectedTask)
          if (!isActiveActivation(activation) || !activation.is_detail_owner(request)) return
          dispatch({
            type: 'detail_loaded',
            session: session.id,
            activation: activation.id,
            ...request,
            detail: nextDetail,
          })
        } catch {
          if (!isActiveActivation(activation) || !activation.is_detail_owner(request)) return
          activation.select_task(null)
          dispatch({
            type: 'detail_failed',
            session: session.id,
            activation: activation.id,
            ...request,
          })
        }
      } catch (error) {
        if (isActiveActivation(activation)) {
          dispatch(shellActionFailureEvent(activation, error, 'The command could not be applied. Try again.'))
        }
      } finally {
        activation.finish_shell_action(token)
      }
    },
    [refreshSidebar, session, state.detail.value],
  )

  const retryTranscript = useCallback(async () => {
    const activation = activeActivation.current
    if (
      !activation ||
      activation.session !== session ||
      activation.send_owner() !== null
    ) {
      return
    }
    const failureText =
      state.transcript.state.kind === 'error'
        ? state.transcript.state.text
        : TRANSCRIPT_LOAD_ERROR
    dispatch({
      type: 'notice_cleared',
      session: session.id,
      activation: activation.id,
    })
    await loadTranscript(activation, state.transcript.purpose, failureText)
  }, [loadTranscript, session, state.transcript])

  const submit = useCallback(async () => {
    const text = (queuedText.current ?? draft).trim()
    queuedText.current = null
    const activation = activeActivation.current
    if (
      !activation ||
      activation.session !== session ||
      state.transcript.baseline !== 'ready' ||
      text.length === 0 ||
      inflightText.current.has(text)
    ) {
      return
    }
    const token = activation.try_start_send()
    if (!token) return
    inflightText.current.set(text, token)
    closeSendWatch.current?.()
    const submission = submissionController.submission_for(
      text,
      () => session.client.createOperationId(),
    )
    const outgoingId = String(submission.operation_id)
    setOutgoing((current) => [
      ...current.filter((item) => item.text !== text),
      { id: outgoingId, text, state: 'pending' },
    ])
    dispatch({
      type: 'send_started',
      session: session.id,
      activation: activation.id,
      token,
    })
    let closed = false
    let probing = false
    let composerReleased = false
    let lastView: 'absent' | 'waiting' | 'answered' = 'absent'
    let lastIdentity = ''
    let watch: ReturnType<typeof setInterval> | undefined
    let giveUp: ReturnType<typeof setTimeout> | undefined
    const ownsSend = () =>
      isActiveActivation(activation) && activation.send_owner() === token
    const newerSend = () => {
      const owner = activation.send_owner()
      return owner !== null && owner !== token
    }
    const closeWatch = () => {
      if (closed) return false
      closed = true
      clearInterval(watch)
      clearTimeout(giveUp)
      if (closeSendWatch.current === closeWatch) closeSendWatch.current = null
      return true
    }
    closeSendWatch.current = closeWatch
    const releaseComposer = () => {
      if (composerReleased || !ownsSend()) return
      composerReleased = true
      submissionController.discard(submission.operation_id)
      dispatch({
        type: 'send_admitted',
        session: session.id,
        activation: activation.id,
        token,
      })
      dispatch({
        type: 'send_succeeded',
        session: session.id,
        activation: activation.id,
        token,
      })
      if (inflightText.current.get(text) === token) inflightText.current.delete(text)
      activation.finish_send(token)
    }
    const showStored = async (
      view: 'waiting' | 'answered',
      messages: readonly RouterMessage[],
    ) => {
      const identity = transcriptIdentity(messages)
      if (identity === lastIdentity || closed || newerSend()) return
      lastIdentity = identity
      await loadTranscript(
        activation,
        'refresh',
        TRANSCRIPT_REFRESH_ERROR,
        view === 'answered' ? 'announce' : 'silent',
      )
    }
    const probeStoredSend = async () => {
      if (closed || probing) return
      if (newerSend()) {
        closeWatch()
        return
      }
      if (!composerReleased && !ownsSend()) return
      probing = true
      try {
        const transcript = await within(
          activation.session.client.transcript(),
          SEND_TRANSCRIPT_PROBE_MS,
        )
        if (!transcript || closed || newerSend()) return
        const view = storedOwnerSend(transcript.messages, text)
        lastView = view
        if (view === 'absent') return
        releaseComposer()
        await showStored(view, transcript.messages)
      } finally {
        probing = false
      }
    }
    watch = setInterval(() => {
      void probeStoredSend()
    }, SEND_WATCH_MS)
    giveUp = setTimeout(() => {
      if (newerSend()) {
        closeWatch()
        return
      }
      if (lastView === 'answered') {
        closeWatch()
        return
      }
      if (lastView === 'absent') {
        if (!closeWatch() || !ownsSend()) return
        submissionController.discard(submission.operation_id)
        setOutgoing((current) =>
          current.map((item) =>
            item.id === String(submission.operation_id) ? { ...item, state: 'failed' } : item,
          ),
        )
        dispatch({
          type: 'send_failed',
          session: session.id,
          activation: activation.id,
          token,
          text: SEND_FAILED_TEXT,
        })
        activation.finish_send(token)
        return
      }
      closeWatch()
      dispatch({
        type: 'stored_send_unanswered',
        session: session.id,
        activation: activation.id,
        text: PROCESSING_PENDING_TEXT,
      })
    }, SEND_GIVE_UP_MS)
    try {
      const attachmentIds = pendingAttachmentIds.current
      pendingAttachmentIds.current = []
      const admission =
        attachmentIds.length > 0
          ? await session.client.send(submission.operation_id, text, attachmentIds)
          : await session.client.send(submission.operation_id, text)
      if (newerSend()) {
        closeWatch()
        return
      }
      const owned = !composerReleased && closeWatch() && ownsSend()
      if (owned) {
        submissionController.discard(submission.operation_id)
        dispatch({
          type: 'send_admitted',
          session: session.id,
          activation: activation.id,
          token,
          sent_text: text,
        })
      } else {
        closeWatch()
        if (!composerReleased) {
          dispatch({
            type: 'send_admitted',
            session: session.id,
            activation: activation.id,
            token,
            sent_text: text,
          })
        }
      }
      const admittedFailure = admissionOutcomeText(admission)
      const refresh = await loadTranscript(
        activation,
        'refresh',
        TRANSCRIPT_REFRESH_ERROR,
        admittedFailure === null ? 'announce' : 'silent',
        admittedFailure ?? undefined,
      )
      if (!owned || !ownsSend()) return
      const transcriptHasFailure =
        admittedFailure !== null &&
        refresh.kind === 'loaded' &&
        refresh.messages.some(
          (message) => message.role === 'router' && message.text === admittedFailure,
        )
      if (admittedFailure !== null && !transcriptHasFailure) {
        dispatch({
          type: 'admitted_failure_reported',
          session: session.id,
          activation: activation.id,
          token,
          text: admittedFailure,
        })
      } else if (refresh.kind === 'failed') {
        dispatch({
          type: 'refresh_failed',
          session: session.id,
          activation: activation.id,
          token,
          text: TRANSCRIPT_REFRESH_NOTICE,
        })
      } else {
        dispatch({
          type: 'send_succeeded',
          session: session.id,
          activation: activation.id,
          token,
        })
      }
    } catch (error) {
      closeWatch()
      if (!ownsSend()) return
      if (
        submissionErrorDisposition(error) ===
        SubmissionErrorDisposition.DiscardPreAdmission
      ) {
        submissionController.discard(submission.operation_id)
      }
      await within(
        loadTranscript(activation, 'refresh', TRANSCRIPT_REFRESH_ERROR),
        SEND_TRANSCRIPT_PROBE_MS,
      )
      if (!ownsSend()) return
      setOutgoing((current) =>
        current.map((item) =>
          item.id === String(submission.operation_id) ? { ...item, state: 'failed' } : item,
        ),
      )
      dispatch({
        type: 'send_failed',
        session: session.id,
        activation: activation.id,
        token,
        text: error instanceof SuperAgentRequestError ? error.message : SEND_FAILED_TEXT,
      })
    } finally {
      if (inflightText.current.get(text) === token) inflightText.current.delete(text)
      closeWatch()
      activation.finish_send(token)
    }
  }, [
    draft,
    loadTranscript,
    session,
    state.transcript.baseline,
    submissionController,
  ])

  submitRef.current = submit

  const retryOutgoing = useCallback((id: string) => {
    const item = outgoingRef.current.find((entry) => entry.id === id)
    if (!item || item.state !== 'failed') return
    queuedText.current = item.text
    void submitRef.current()
  }, [])

  useEffect(() => {
    setOutgoing((current) => {
      const next = current.filter(
        (item) =>
          item.state === 'failed' ||
          !state.transcript.messages.some(
            (message) => message.role === 'owner' && message.text === item.text,
          ),
      )
      return next.length === current.length ? current : next
    })
  }, [state.transcript.messages])

  const messageIds = useRef('')
  messageIds.current = state.transcript.messages.map((message) => message.message_id).join('\n')
  useEffect(() => {
    if (client.dataSource !== 'live') return
    if (outgoing.length === 0 && activity.length === 0) return
    let stopped = false
    const timer = window.setInterval(() => {
      const activation = activeActivation.current
      if (!activation || activation.session !== session || stopped) return
      void activation.session.client.transcript().then((body) => {
        if (stopped || !isActiveActivation(activation)) return
        setActivity(body.activity ?? [])
        const nextIds = body.messages.map((message) => message.message_id).join('\n')
        if (nextIds !== messageIds.current) {
          void loadTranscript(activation, 'refresh', TRANSCRIPT_REFRESH_ERROR, 'silent')
        }
      })
    }, 1000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [activity.length, client.dataSource, loadTranscript, outgoing.length, session])

  const acknowledgeAnnouncement = useCallback(
    (sequence: number) => {
      const activation = activeActivation.current
      if (!activation || activation.session !== session) return
      dispatch({
        type: 'announcement_acknowledged',
        session: session.id,
        activation: activation.id,
        sequence,
      })
    },
    [session],
  )

  const stageAttachments = useCallback(
    async (files: readonly File[]) => {
      if (!client.uploadAttachment) return
      const ids: string[] = []
      for (const file of files) {
        const saved = await client.uploadAttachment({
          name: file.name,
          mediaType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })
        ids.push(saved.attachment_id)
      }
      pendingAttachmentIds.current = ids
    },
    [client],
  )

  const decideApproval = useCallback(
    async (approvalId: string, decision: 'approve' | 'deny') => {
      const activation = activeActivation.current
      if (!activation || !isActiveActivation(activation)) return
      await activation.session.client.decideApproval?.(approvalId, decision)
      await refreshSidebar(activation)
    },
    [refreshSidebar],
  )

  return {
    rows: state.sidebar.rows,
    messages: state.transcript.messages,
    transcriptState: state.transcript.state,
    admittedStatusMessageId: state.admitted_status_message_id,
    admission:
      state.transcript.baseline === 'ready'
        ? { kind: 'ready' }
        : {
            kind: 'blocked',
            reason:
              state.transcript.baseline === 'failed'
                ? 'hydrate_failed'
                : 'hydrating',
          },
    operation: state.operation,
    announcement: state.announcement_queue[0] ?? null,
    draft,
    setDraft: updateDraft,
    acknowledgeAnnouncement,
    retryTranscript,
    notice: state.notice,
    detail: state.detail.value,
    pinMark: state.detail.value
      ? pinMarkFor(state.sidebar.rows, state.detail.value.task_id)
      : 'unpinned',
    openTask,
    closeDetail,
    quote,
    pin,
    hostCommand,
    submit,
    approvals: state.sidebar.approvals,
    decideApproval,
    canAttach: client.uploadAttachment !== undefined,
    stageAttachments,
    outgoing,
    retryOutgoing,
    activity,
  }
}
