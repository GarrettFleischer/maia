import { useState } from 'react'
import { ApprovalSheet } from '@/components/approval/ApprovalSheet'
import { NeedsHumanBanner } from '@/components/conversation/NeedsHumanBanner'
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
}: {
  dataSource: SuperAgentDataSource
  layout: ConversationLayout
  activityLabel: string
  onStopAll: () => void
  router: RouterBindings
}) {
  const { state, dispatch } = useMaiaState()
  const [approvalOpen, setApprovalOpen] = useState(false)
  const pending = dataSource === 'fixture' ? state.pending_approval : null
  const composerDisabled = pending !== null

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
      <header className="maia-conv-head">
        <h1>Router</h1>
        <p>One conversation · {activityLabel}</p>
      </header>

      {dataSource === 'fixture' ? (
        <NeedsHumanBanner onApprove={() => setApprovalOpen(true)} onDeny={denyPending} />
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
        onDraftChange={router.setDraft}
        onRetryTranscript={() => {
          void router.retryTranscript()
        }}
        onAnnouncementAcknowledged={router.acknowledgeAnnouncement}
        onSubmit={() => {
          void router.submit()
        }}
        accessory={
          dataSource === 'fixture' && layout === 'phone' && state.activity.running > 0 ? (
            <div className="maia-phone-stop" data-testid="phone-stop-bar">
              <span>{state.activity.running} running</span>
              <StopAllButton onStop={onStopAll} />
            </div>
          ) : null
        }
      />

      {router.detail ? (
        <TaskDetail
          detail={router.detail}
          pin={router.pinMark}
          operation={router.operation}
          onClose={() => router.closeDetail()}
          onQuote={(taskId) => router.quote(taskId)}
          onPin={(taskId, mark) => router.pin(taskId, mark)}
        />
      ) : null}

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
