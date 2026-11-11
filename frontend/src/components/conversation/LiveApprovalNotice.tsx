import type { LiveApproval } from '@/api/superAgentTypes'

export function openLiveApproval(
  approvals: readonly LiveApproval[],
  nowSeconds: number,
): LiveApproval | null {
  return approvals.find((approval) => approval.expires_at > nowSeconds) ?? null
}

export function LiveApprovalNotice({
  approval,
  sheetOpen,
  onOpen,
  onClose,
  onDecide,
}: {
  approval: LiveApproval
  sheetOpen: boolean
  onOpen: () => void
  onClose: () => void
  onDecide: (decision: 'approve' | 'deny') => void
}) {
  const taint = approval.taint === 'untrusted' ? 'Untrusted' : 'Trusted'
  return (
    <>
      <div className="maia-needs-you" role="status">
        <button type="button" className="maia-btn" onClick={onOpen}>
          Needs you
        </button>
        <p>{approval.reason}</p>
      </div>
      {sheetOpen ? (
        <div className="maia-approval-sheet" role="dialog" aria-label="Needs you">
          <p>{approval.grant_text}</p>
          <p>{taint}</p>
          <button type="button" className="maia-btn maia-btn--primary" onClick={() => onDecide('approve')}>
            Allow
          </button>
          <button type="button" className="maia-btn" onClick={() => onDecide('deny')}>
            Deny
          </button>
          <button type="button" className="maia-btn" onClick={onClose}>
            Close
          </button>
        </div>
      ) : null}
    </>
  )
}
