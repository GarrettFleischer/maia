export type SidebarSection = 'needs_you' | 'working' | 'completed' | 'pinned' | 'archive'

export type TaskPhaseName =
  | 'queued'
  | 'running'
  | 'waiting_for_user'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'stopped'
  | 'cancelled'
  | 'abandoned'

export type PinMark = 'pinned' | 'unpinned'

export type DetailView = 'open' | 'closed_once'

export type AdmittedRouteName = 'admit' | 'ask' | 'refuse'

export type RoutingFailureReason = 'model_provider_unavailable' | 'route_unreadable'

declare const submissionOperationBrand: unique symbol
export type SubmissionOperationId = string & {
  readonly [submissionOperationBrand]: 'SubmissionOperationId'
}

declare const superAgentBackendScopeBrand: unique symbol
export type SuperAgentBackendScope = string & {
  readonly [superAgentBackendScopeBrand]: 'SuperAgentBackendScope'
}

export type MessageAdmissionOutcome =
  | { kind: 'routed'; route: AdmittedRouteName }
  | { kind: 'routing_failed'; reason: RoutingFailureReason }
  | { kind: 'processing_failed'; reason: 'processing_unavailable' }
  | { kind: 'processing_pending'; reason: 'processing_pending' }
  | { kind: 'unknown_outcome' }

export interface MessageAdmissionResult {
  admission: 'admitted'
  message_id: string | null
  outcome: MessageAdmissionOutcome
}

export type CriterionMarkName = 'pending' | 'satisfied' | 'waived' | 'inapplicable'

export type SuperAgentDataSource = 'fixture' | 'live'

export interface SidebarRow {
  task_id: string
  title: string
  section: SidebarSection
  phase: TaskPhaseName
  summary: string
  elapsed_ms: number
  criteria_done: number
  criteria_total: number
  children: SidebarRow[]
}

export interface AttachmentChip {
  attachment_id: string
  safe_name: string
  media_type: string
  byte_size: number
}

export interface RouterMessage {
  message_id: string
  role: 'owner' | 'router'
  text: string
  thinking?: string
  route?: string
  attachments?: AttachmentChip[]
}

export interface ActivityLine {
  seq: number
  label: string
  task_id?: string
}

export interface OutgoingMessage {
  id: string
  text: string
  state: 'pending' | 'failed'
}

export interface TranscriptLine {
  id: string
  author: string
  text: string
}

export interface ToolEventRecord {
  call_id: string
  name: string
  summary: string
}

export interface ArtifactRecord {
  artifact_id: string
  label: string
}

export interface AttemptRecord {
  attempt_id: string
  phase: TaskPhaseName
  summary: string
}

export interface DecisionRecord {
  decision_id: string
  text: string
}

export interface CriterionRecord {
  criterion_id: string
  text: string
  mark: CriterionMarkName
}

export interface TaskHelperRef {
  task_id: string
  title: string
}

export interface TaskDetail {
  task_id: string
  title: string
  original_prompt: string
  acceptance_context: string
  transcript: TranscriptLine[]
  tool_events: ToolEventRecord[]
  artifacts: ArtifactRecord[]
  attempts: AttemptRecord[]
  decisions: DecisionRecord[]
  criteria: CriterionRecord[]
  helpers: TaskHelperRef[]
}

export type HostCommand =
  | { command: 'stop'; task_id: string }
  | { command: 'stop_all' }
  | { command: 'cancel'; task_id: string }
  | { command: 'abandon'; task_id: string }

export type ComposerNotice =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'failed'; text: string }
  | { kind: 'admitted_failure'; text: string }
  | { kind: 'refresh_failed'; text: string }

export type TranscriptState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready' }
  | { kind: 'error'; text: string }

export type ConnectionPhase = 'connected' | 'reconnecting'

export interface ConnectionSnapshot {
  phase: ConnectionPhase
  origin: string
}

export interface LiveApproval {
  approval_id: string
  task_id: string
  kind: 'login' | 'consent' | 'capability'
  taint: 'trusted' | 'untrusted'
  grant_text: string
  reason: string
  created_at: number
  expires_at: number
}

export interface SuperAgentClient {
  readonly dataSource: SuperAgentDataSource
  readonly backendScope: SuperAgentBackendScope
  createOperationId(): SubmissionOperationId
  sidebar(): Promise<{ rows: SidebarRow[]; approvals?: LiveApproval[] }>
  decideApproval?(approvalId: string, decision: 'approve' | 'deny'): Promise<void>
  transcript(): Promise<{ messages: RouterMessage[]; activity?: ActivityLine[] }>
  task(taskId: string): Promise<TaskDetail>
  send(
    operationId: SubmissionOperationId,
    text: string,
    attachmentIds?: readonly string[],
  ): Promise<MessageAdmissionResult>
  uploadAttachment?(file: {
    name: string
    mediaType: string
    bytes: Uint8Array
  }): Promise<AttachmentChip>
  pin(taskId: string, pin: PinMark): Promise<{ pin: PinMark }>
  openDetail(taskId: string): Promise<{ view: 'open' | 'closed_once' }>
  closeDetail(taskId: string): Promise<{ view: 'closed_once' }>
  insertReference(taskId: string): Promise<{ composer_insert: string }>
  hostCommand(command: HostCommand): Promise<{ phase: TaskPhaseName }>
  subscribeSidebar?(onRows: (rows: SidebarRow[], approvals?: LiveApproval[]) => void): () => void
  subscribeConnection?(onChange: (snapshot: ConnectionSnapshot) => void): () => void
  dispose?(): void
  inspector?(): Promise<InspectorSnapshot>
}

export type CacheResidence = 'cached' | 'uncached' | 'unreported'

export interface InspectorSlot {
  ordinal: number
  label: string
  bytes: number
  residence: CacheResidence
  detail: string
}

export interface InspectorRecallItem {
  id: string
  kind: 'claim' | 'fact'
  sentence: string
  score: number
  taint?: 'trusted' | 'untrusted' | null
  walked?: string[]
}

export interface InspectorTraceStep {
  kind: 'reasoning' | 'route' | 'reply'
  text: string
}

export interface InspectorTurn {
  ordinal: number
  message_id: string
  cached_percent: number | null
  slots: InspectorSlot[]
  recall: InspectorRecallItem[]
  thinking: string | null
  route: string | null
  reply: string
  trace: InspectorTraceStep[]
  used?: string[]
}

export interface InspectorSnapshot {
  turns: InspectorTurn[]
}
