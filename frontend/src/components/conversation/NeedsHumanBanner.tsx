import { useMaiaState } from '@/hooks/useMaiaState'
import { selectNeedsHumanBannerVisible } from '@/state/maiaReducer'

export function NeedsHumanBanner({
  onApprove,
  onDeny,
}: {
  onApprove: () => void
  onDeny: () => void
}) {
  const { state } = useMaiaState()
  if (!selectNeedsHumanBannerVisible(state) || !state.pending_approval) {
    return null
  }
  const pending = state.pending_approval
  return (
    <div
      className="maia-needs-human-banner"
      data-testid="needs-human-banner"
      role="region"
      aria-label="Needs your attention"
    >
      <p>
        Needs you · Approve {pending.capability}: {pending.target_label} (digest{' '}
        <span className="maia-mono">{pending.digest}</span>)
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="maia-btn maia-btn--danger" onClick={onDeny}>
          Deny
        </button>
        <button type="button" className="maia-btn maia-btn--primary" onClick={onApprove}>
          Approve
        </button>
      </div>
    </div>
  )
}
