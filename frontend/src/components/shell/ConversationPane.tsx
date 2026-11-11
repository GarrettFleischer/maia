import { useState, type ReactNode } from 'react'
import { ApprovalSheet } from '@/components/approval/ApprovalSheet'
import { NeedsHumanBanner } from '@/components/conversation/NeedsHumanBanner'
import { LiveApprovalNotice, openLiveApproval } from '@/components/conversation/LiveApprovalNotice'
import { RouterConversation } from '@/components/shell/RouterConversation'
import { StopAllButton } from '@/components/shell/StopAllButton'
import { TaskDetail } from '@/components/shell/TaskDetail'
import { useMaiaState } from '@/hooks/useMaiaState'
import type { RouterBindings } from '@/hooks/useSuperAgent'
import type { SuperAgentDataSource } from '@/api/superAgentTypes'

export type ConversationLayout = 'desktop' | 'tablet' | 'phone'

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
          <header className={headerAction ? 'maia-conv-head maia-conv-head--split' : 'maia-conv-head'}>
            <div>
              <h1>Router</h1>
              <p>One conversation · {activityLabel}</p>
            </div>
            {headerAction}
          </header>

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
