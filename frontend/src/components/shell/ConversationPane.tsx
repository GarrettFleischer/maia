import { useState, type ReactNode } from 'react'
import { ApprovalSheet } from '@/components/approval/ApprovalSheet'
import { NeedsHumanBanner } from '@/components/conversation/NeedsHumanBanner'
import { LiveApprovalNotice, openLiveApproval } from '@/components/conversation/LiveApprovalNotice'
import { shortWorkStatus, taskStripLabel } from '@/api/superAgentFormat'
import { RouterConversation } from '@/components/shell/RouterConversation'
import { StopAllButton } from '@/components/shell/StopAllButton'
import { TaskRail } from '@/components/shell/TaskRail'
import { TaskDetail } from '@/components/shell/TaskDetail'
import { useMaiaState } from '@/hooks/useMaiaState'
import type { RouterBindings } from '@/hooks/useSuperAgent'
import type { PinMark, SidebarRow, SuperAgentDataSource } from '@/api/superAgentTypes'

export type ConversationLayout = 'desktop' | 'tablet' | 'phone'

export function TaskStrip({
  rows,
  onOpen,
  onPin,
}: {
  rows: readonly SidebarRow[]
  onOpen: (taskId: string) => void
  onPin: (taskId: string, mark: PinMark) => void
}) {
  const [open, setOpen] = useState(false)
  const needs = rows.filter((row) => row.section === 'needs_you')
  return (
    <section className="maia-task-strip" aria-label="Tasks">
      <button
        type="button"
        className="maia-task-strip-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {taskStripLabel(rows)}
      </button>
      {!open
        ? needs.map((row) => (
            <button key={row.task_id} type="button" className="maia-btn" onClick={() => onOpen(row.task_id)}>
              {`Open ${shortWorkStatus(row.title) || row.title}`}
            </button>
          ))
        : null}
      {open ? <TaskRail rows={rows} onOpen={onOpen} onPin={onPin} /> : null}
    </section>
  )
}

export function ConversationPane({
  dataSource,
  layout,
  activityLabel,
  onStopAll,
  router,
  phoneStop,
  headerAction = null,
  factsUsed,
  onInspectFacts,
  title = 'Router',
  onBack,
  tasks = [],
  onOpenTask,
}: {
  dataSource: SuperAgentDataSource
  layout: ConversationLayout
  activityLabel: string
  onStopAll: () => void
  router: RouterBindings
  phoneStop: string | null
  headerAction?: ReactNode
  factsUsed?: ReadonlyMap<string, readonly string[]>
  onInspectFacts?: (messageId: string, ids: readonly string[]) => void
  title?: string
  onBack?: () => void
  tasks?: readonly SidebarRow[]
  onOpenTask?: (taskId: string) => void
}) {
  const { state, dispatch } = useMaiaState()
  const [approvalOpen, setApprovalOpen] = useState(false)
  const pending = dataSource === 'fixture' ? state.pending_approval : null
  const liveApproval =
    dataSource === 'live' ? openLiveApproval(router.approvals, Date.now() / 1000) : null
  const composerDisabled = pending !== null || liveApproval !== null

  const denyPending = () => {
    if (!pending) {
      return
    }
    dispatch({
      type: 'approval_deny',
      approval_id: pending.approval_id,
      at: new Date().toISOString(),
    })
    setApprovalOpen(false)
  }

  return (
    <section className="maia-conversation" aria-label="Conversation">
      {router.detail ? (
        <TaskDetail
          detail={router.detail}
          pin={router.pinMark}
          operation={router.operation}
          onClose={() => {
            void router.closeDetail()
          }}
          onQuote={(taskId) => {
            void router.quote(taskId)
          }}
          onPin={(taskId, mark) => {
            void router.pin(taskId, mark)
          }}
        />
      ) : (
        <>
          {layout === 'phone' ? null : (
            <header className={headerAction || onBack ? 'maia-conv-head maia-conv-head--split' : 'maia-conv-head'}>
              {onBack ? (
                <button
                  type="button"
                  className="maia-btn"
                  style={{ minHeight: 44, minWidth: 44 }}
                  onClick={onBack}
                >
                  Back
                </button>
              ) : null}
              <div>
                <h1>{title}</h1>
                <p>One conversation · {activityLabel}</p>
              </div>
              {headerAction}
            </header>
          )}
          {tasks.length > 0 && onOpenTask ? (
            <TaskStrip
              rows={tasks}
              onOpen={onOpenTask}
              onPin={(taskId, mark) => void router.pin(taskId, mark)}
            />
          ) : null}

          {dataSource === 'fixture' ? (
            <NeedsHumanBanner onApprove={() => setApprovalOpen(true)} onDeny={denyPending} />
          ) : null}
          {liveApproval ? (
            <LiveApprovalNotice
              approval={liveApproval}
              sheetOpen={approvalOpen}
              onOpen={() => setApprovalOpen(true)}
              onClose={() => setApprovalOpen(false)}
              onDecide={(decision) => {
                setApprovalOpen(false)
                void router.decideApproval(liveApproval.approval_id, decision)
              }}
            />
          ) : null}

          <RouterConversation
            messages={router.messages}
            transcriptState={router.transcriptState}
            admittedStatusMessageId={router.admittedStatusMessageId}
            admission={router.admission}
            operation={router.operation}
            announcement={router.announcement}
            draft={router.draft}
            notice={router.notice}
            disabled={composerDisabled}
            submitOnEnter={layout !== 'phone'}
            onDraftChange={router.setDraft}
            onRetryTranscript={() => {
              void router.retryTranscript()
            }}
            onAnnouncementAcknowledged={router.acknowledgeAnnouncement}
            onSubmit={() => {
              void router.submit()
            }}
            factsUsed={factsUsed}
            onInspectFacts={onInspectFacts}
            canAttach={router.canAttach}
            stageAttachments={router.stageAttachments}
            outgoing={router.outgoing}
            onRetryOutgoing={router.retryOutgoing}
            activity={router.activity}
            onStopTask={(taskId) => {
              void router.hostCommand({ command: 'stop', task_id: taskId })
            }}
            placeholder={`Message ${title}`}
            accessory={
              phoneStop ? (
                <div className="maia-phone-stop" data-testid="phone-stop-bar">
                  <span>{phoneStop}</span>
                  <StopAllButton onStop={onStopAll} />
                </div>
              ) : null
            }
          />
        </>
      )}

      {pending ? (
        <ApprovalSheet
          open={approvalOpen}
          capability={pending.capability}
          targetLabel={pending.target_label}
          digest={pending.digest}
          onAllowOnce={() => {
            dispatch({
              type: 'approval_allow_once',
              approval_id: pending.approval_id,
              at: new Date().toISOString(),
            })
            setApprovalOpen(false)
          }}
          onAlwaysAllowExact={() => {
            dispatch({
              type: 'approval_always_allow_exact',
              approval_id: pending.approval_id,
              at: new Date().toISOString(),
              created_by: state.security.activated_by,
            })
            setApprovalOpen(false)
          }}
          onDeny={denyPending}
          onClose={() => setApprovalOpen(false)}
        />
      ) : null}
    </section>
  )
}
