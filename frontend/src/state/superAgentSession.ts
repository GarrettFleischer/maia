import type {
  ComposerNotice,
  LiveApproval,
  RouterMessage,
  SidebarRow,
  TaskDetail,
  TranscriptState,
} from '@/api/superAgentTypes'
import { appendReference } from '@/api/superAgentFormat'

export type ClientSessionId = symbol
export type ClientActivationId = symbol
export type SendOperationToken = symbol
export type ResourceStatus = 'loading' | 'ready' | 'error'
export type TranscriptLoadPurpose = 'hydrate' | 'refresh'
export type TranscriptAnnouncementMode = 'announce' | 'silent'
export type TranscriptBaseline = 'pending' | 'ready' | 'failed'
export type AdmissionState =
  | { kind: 'ready' }
  | { kind: 'blocked'; reason: 'hydrating' | 'hydrate_failed' }
export type DetailLoadPurpose = 'open' | 'refresh'
export type SendOperation =
  | { kind: 'idle' }
  | { kind: 'sending'; token: SendOperationToken }

export interface RouterAnnouncement {
  sequence: number
  message_id: string
  text: string
}

interface SidebarResource {
  latest_request_id: number
  active_request: number | null
  status: ResourceStatus
  rows: SidebarRow[]
  approvals: LiveApproval[]
}

interface TranscriptResource {
  latest_request_id: number
  active_request: { request_id: number; purpose: TranscriptLoadPurpose } | null
  purpose: TranscriptLoadPurpose
  baseline: TranscriptBaseline
  state: TranscriptState
  messages: RouterMessage[]
}

interface DetailResource {
  latest_request_id: number
  active_request: {
    request_id: number
    purpose: DetailLoadPurpose
    task_id: string
  } | null
  selected_task_id: string | null
  value: TaskDetail | null
}

export interface SuperAgentState {
  session: ClientSessionId
  activation: ClientActivationId
  sidebar: SidebarResource
  transcript: TranscriptResource
  operation: SendOperation
  draft: string
  notice: ComposerNotice
  detail: DetailResource
  seen_message_ids: ReadonlySet<string>
  announcement_queue: readonly RouterAnnouncement[]
  next_announcement_sequence: number
  admitted_status_message_id: string | null
}

type SessionEvent =
  | {
      type: 'activation_started'
      session: ClientSessionId
      activation: ClientActivationId
    }
  | {
      type: 'sidebar_started'
      session: ClientSessionId
      activation: ClientActivationId
      request_id: number
    }
  | {
      type: 'sidebar_loaded'
      session: ClientSessionId
      activation: ClientActivationId
      request_id: number
      rows: SidebarRow[]
      approvals: LiveApproval[]
    }
  | {
      type: 'sidebar_failed'
      session: ClientSessionId
      activation: ClientActivationId
      request_id: number
    }
  | {
      type: 'transcript_started'
      session: ClientSessionId
      activation: ClientActivationId
      request_id: number
      purpose: TranscriptLoadPurpose
    }
  | {
      type: 'transcript_loaded'
      session: ClientSessionId
      activation: ClientActivationId
      request_id: number
      purpose: TranscriptLoadPurpose
      announcement?: TranscriptAnnouncementMode
      admitted_failure_text?: string
      messages: RouterMessage[]
    }
  | {
      type: 'transcript_failed'
      session: ClientSessionId
      activation: ClientActivationId
      request_id: number
      purpose: TranscriptLoadPurpose
      text: string
    }
  | {
      type: 'draft_changed'
      session: ClientSessionId
      activation: ClientActivationId
      draft: string
    }
  | {
      type: 'draft_reference_inserted'
      session: ClientSessionId
      activation: ClientActivationId
      insert: string
    }
  | {
      type: 'notice_cleared'
      session: ClientSessionId
      activation: ClientActivationId
    }
  | {
      type: 'shell_action_failed'
      session: ClientSessionId
      activation: ClientActivationId
      text: string
    }
  | {
      type: 'send_started'
      session: ClientSessionId
      activation: ClientActivationId
      token: SendOperationToken
    }
  | {
      type: 'send_admitted'
      session: ClientSessionId
      activation: ClientActivationId
      token: SendOperationToken
      sent_text?: string
    }
  | {
      type: 'stored_send_unanswered'
      session: ClientSessionId
      activation: ClientActivationId
      text: string
    }
  | {
      type: 'send_succeeded'
      session: ClientSessionId
      activation: ClientActivationId
      token: SendOperationToken
    }
  | {
      type: 'admitted_failure_reported'
      session: ClientSessionId
      activation: ClientActivationId
      token: SendOperationToken
      text: string
    }
  | {
      type: 'send_failed'
      session: ClientSessionId
      activation: ClientActivationId
      token: SendOperationToken
      text: string
    }
  | {
      type: 'refresh_failed'
      session: ClientSessionId
      activation: ClientActivationId
      token: SendOperationToken
      text: string
    }
  | {
      type: 'detail_started'
      session: ClientSessionId
      activation: ClientActivationId
      request_id: number
      purpose: DetailLoadPurpose
      task_id: string
    }
  | {
      type: 'detail_loaded'
      session: ClientSessionId
      activation: ClientActivationId
      request_id: number
      purpose: DetailLoadPurpose
      task_id: string
      detail: TaskDetail
    }
  | {
      type: 'detail_failed'
      session: ClientSessionId
      activation: ClientActivationId
      request_id: number
      purpose: DetailLoadPurpose
      task_id: string
    }
  | {
      type: 'detail_closed'
      session: ClientSessionId
      activation: ClientActivationId
      task_id: string
    }
  | {
      type: 'announcement_acknowledged'
      session: ClientSessionId
      activation: ClientActivationId
      sequence: number
    }

export type SuperAgentEvent = SessionEvent

export function createSuperAgentState(
  session: ClientSessionId,
  activation: ClientActivationId,
): SuperAgentState {
  return {
    session,
    activation,
    sidebar: {
      latest_request_id: 0,
      active_request: null,
      status: 'loading',
      rows: [],
      approvals: [],
    },
    transcript: {
      latest_request_id: 0,
      active_request: null,
      purpose: 'hydrate',
      baseline: 'pending',
      state: { kind: 'loading' },
      messages: [],
    },
    operation: { kind: 'idle' },
    draft: '',
    notice: { kind: 'idle' },
    detail: {
      latest_request_id: 0,
      active_request: null,
      selected_task_id: null,
      value: null,
    },
    seen_message_ids: new Set(),
    announcement_queue: [],
    next_announcement_sequence: 1,
    admitted_status_message_id: null,
  }
}

export function dedupeRouterMessages(messages: readonly RouterMessage[]): RouterMessage[] {
  const seen = new Set<string>()
  const deduped: RouterMessage[] = []
  for (const message of messages) {
    if (seen.has(message.message_id)) continue
    seen.add(message.message_id)
    deduped.push(message)
  }
  return deduped
}

function applyTranscript(
  state: SuperAgentState,
  purpose: TranscriptLoadPurpose,
  announcement: TranscriptAnnouncementMode,
  messages: readonly RouterMessage[],
): Pick<
  SuperAgentState,
  'seen_message_ids' | 'announcement_queue' | 'next_announcement_sequence'
> & { messages: RouterMessage[] } {
  const deduped = dedupeRouterMessages(messages)
  const seen = new Set(state.seen_message_ids)
  if (purpose === 'hydrate' || announcement === 'silent') {
    for (const message of deduped) seen.add(message.message_id)
    return {
      messages: deduped,
      seen_message_ids: seen,
      announcement_queue: state.announcement_queue,
      next_announcement_sequence: state.next_announcement_sequence,
    }
  }

  const announcementQueue = [...state.announcement_queue]
  let sequence = state.next_announcement_sequence
  for (const message of deduped) {
    if (seen.has(message.message_id)) continue
    seen.add(message.message_id)
    if (message.role === 'router') {
      announcementQueue.push({
        sequence,
        message_id: message.message_id,
        text: message.text,
      })
      sequence += 1
    }
  }
  return {
    messages: deduped,
    seen_message_ids: seen,
    announcement_queue: announcementQueue,
    next_announcement_sequence: sequence,
  }
}

function ownsSend(state: SuperAgentState, token: SendOperationToken): boolean {
  return state.operation.kind === 'sending' && state.operation.token === token
}

function ownsTranscriptRequest(
  state: SuperAgentState,
  requestId: number,
  purpose: TranscriptLoadPurpose,
): boolean {
  return (
    state.transcript.state.kind === 'loading' &&
    state.transcript.active_request?.request_id === requestId &&
    state.transcript.active_request.purpose === purpose
  )
}

function ownsDetailRequest(
  state: SuperAgentState,
  requestId: number,
  purpose: DetailLoadPurpose,
  taskId: string,
): boolean {
  const active = state.detail.active_request
  return (
    active?.request_id === requestId &&
    active.purpose === purpose &&
    active.task_id === taskId &&
    state.detail.selected_task_id === taskId
  )
}

export function reduceSuperAgentState(
  current: SuperAgentState,
  event: SuperAgentEvent,
): SuperAgentState {
  if (event.type === 'activation_started') {
    return createSuperAgentState(event.session, event.activation)
  }
  if (current.session !== event.session || current.activation !== event.activation) return current
  const state = current
  switch (event.type) {
    case 'sidebar_started':
      if (event.request_id <= state.sidebar.latest_request_id) return state
      return {
        ...state,
        sidebar: {
          ...state.sidebar,
          latest_request_id: event.request_id,
          active_request: event.request_id,
          status: 'loading',
        },
      }
    case 'sidebar_loaded':
      if (
        state.sidebar.status !== 'loading' ||
        state.sidebar.active_request !== event.request_id
      ) {
        return state
      }
      return {
        ...state,
        sidebar: {
          latest_request_id: state.sidebar.latest_request_id,
          active_request: null,
          status: 'ready',
          rows: event.rows,
          approvals: event.approvals,
        },
      }
    case 'sidebar_failed':
      if (
        state.sidebar.status !== 'loading' ||
        state.sidebar.active_request !== event.request_id
      ) {
        return state
      }
      return {
        ...state,
        sidebar: {
          latest_request_id: state.sidebar.latest_request_id,
          active_request: null,
          status: 'error',
          rows: [],
          approvals: state.sidebar.approvals,
        },
      }
    case 'transcript_started':
      if (event.request_id <= state.transcript.latest_request_id) return state
      if (event.purpose === 'refresh' && state.transcript.baseline !== 'ready') return state
      return {
        ...state,
        transcript: {
          ...state.transcript,
          latest_request_id: event.request_id,
          active_request: { request_id: event.request_id, purpose: event.purpose },
          purpose: event.purpose,
          state: { kind: 'loading' },
        },
      }
    case 'transcript_loaded': {
      if (!ownsTranscriptRequest(state, event.request_id, event.purpose)) return state
      const applied = applyTranscript(
        state,
        event.purpose,
        event.announcement ?? (event.purpose === 'hydrate' ? 'silent' : 'announce'),
        event.messages,
      )
      return {
        ...state,
        transcript: {
          latest_request_id: state.transcript.latest_request_id,
          active_request: null,
          purpose: event.purpose,
          baseline: event.purpose === 'hydrate' ? 'ready' : state.transcript.baseline,
          state: { kind: applied.messages.length === 0 ? 'empty' : 'ready' },
          messages: applied.messages,
        },
        seen_message_ids: applied.seen_message_ids,
        announcement_queue: applied.announcement_queue,
        next_announcement_sequence: applied.next_announcement_sequence,
        admitted_status_message_id: event.admitted_failure_text
          ? (applied.messages.find(
              (message) =>
                message.role === 'router' &&
                message.text === event.admitted_failure_text,
            )?.message_id ?? null)
          : null,
        notice: { kind: 'idle' },
      }
    }
    case 'transcript_failed':
      if (!ownsTranscriptRequest(state, event.request_id, event.purpose)) return state
      return {
        ...state,
        transcript: {
          ...state.transcript,
          active_request: null,
          purpose: event.purpose,
          baseline: event.purpose === 'hydrate' ? 'failed' : state.transcript.baseline,
          state: { kind: 'error', text: event.text },
        },
        admitted_status_message_id: null,
      }
    case 'draft_changed':
      return {
        ...state,
        draft: event.draft,
        notice: state.notice.kind === 'failed' ? { kind: 'idle' } : state.notice,
      }
    case 'draft_reference_inserted':
      return {
        ...state,
        draft: appendReference(state.draft, event.insert),
        notice: state.notice.kind === 'failed' ? { kind: 'idle' } : state.notice,
      }
    case 'notice_cleared':
      return { ...state, notice: { kind: 'idle' } }
    case 'shell_action_failed':
      return { ...state, notice: { kind: 'failed', text: event.text } }
    case 'send_started':
      if (state.transcript.baseline !== 'ready') return state
      if (state.operation.kind === 'sending' && state.operation.token === event.token) return state
      return {
        ...state,
        operation: { kind: 'sending', token: event.token },
        notice: { kind: 'idle' },
        admitted_status_message_id: null,
      }
    case 'send_admitted':
      if (!ownsSend(state, event.token)) {
        if (
          state.operation.kind === 'idle' &&
          event.sent_text !== undefined &&
          state.draft === event.sent_text
        ) {
          return { ...state, draft: '', notice: { kind: 'idle' } }
        }
        return state
      }
      if (
        event.sent_text !== undefined &&
        state.draft.length > 0 &&
        state.draft !== event.sent_text
      ) {
        return { ...state, notice: { kind: 'idle' } }
      }
      return { ...state, draft: '', notice: { kind: 'idle' } }
    case 'stored_send_unanswered':
      if (state.operation.kind !== 'idle') return state
      return {
        ...state,
        notice: { kind: 'admitted_failure', text: event.text },
      }
    case 'send_succeeded':
      if (!ownsSend(state, event.token)) return state
      return {
        ...state,
        operation: { kind: 'idle' },
        notice: { kind: 'idle' },
      }
    case 'admitted_failure_reported':
      if (!ownsSend(state, event.token)) return state
      return {
        ...state,
        operation: { kind: 'idle' },
        notice: { kind: 'admitted_failure', text: event.text },
      }
    case 'send_failed':
      if (!ownsSend(state, event.token)) return state
      return {
        ...state,
        operation: { kind: 'idle' },
        notice: { kind: 'failed', text: event.text },
      }
    case 'refresh_failed':
      if (!ownsSend(state, event.token)) return state
      return {
        ...state,
        operation: { kind: 'idle' },
        notice: { kind: 'refresh_failed', text: event.text },
      }
    case 'detail_started':
      if (event.request_id <= state.detail.latest_request_id) return state
      if (
        event.purpose === 'refresh' &&
        state.detail.selected_task_id !== event.task_id
      ) {
        return state
      }
      return {
        ...state,
        detail: {
          latest_request_id: event.request_id,
          active_request: {
            request_id: event.request_id,
            purpose: event.purpose,
            task_id: event.task_id,
          },
          selected_task_id: event.task_id,
          value: event.purpose === 'open' ? null : state.detail.value,
        },
      }
    case 'detail_loaded':
      if (
        event.detail.task_id !== event.task_id ||
        !ownsDetailRequest(
          state,
          event.request_id,
          event.purpose,
          event.task_id,
        )
      ) {
        return state
      }
      return {
        ...state,
        detail: {
          ...state.detail,
          active_request: null,
          value: event.detail,
        },
      }
    case 'detail_failed':
      if (
        !ownsDetailRequest(
          state,
          event.request_id,
          event.purpose,
          event.task_id,
        )
      ) {
        return state
      }
      return {
        ...state,
        detail: {
          ...state.detail,
          active_request: null,
          selected_task_id: null,
          value: null,
        },
      }
    case 'detail_closed':
      if (state.detail.selected_task_id !== event.task_id) return state
      return {
        ...state,
        detail: {
          ...state.detail,
          active_request: null,
          selected_task_id: null,
          value: null,
        },
      }
    case 'announcement_acknowledged':
      if (state.announcement_queue[0]?.sequence !== event.sequence) return state
      return {
        ...state,
        announcement_queue: state.announcement_queue.slice(1),
      }
  }
}
