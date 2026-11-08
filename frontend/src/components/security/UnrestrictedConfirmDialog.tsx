import { FocusTrap } from '@/components/a11y/FocusTrap'

export function UnrestrictedConfirmDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <FocusTrap active={open} onClose={onCancel} labelId="unrestricted-confirm-title">
      <h2 id="unrestricted-confirm-title">Enable Unrestricted profile?</h2>
      <p>
        Unrestricted removes Maia approval prompts and process containment for controllable actions.
        Budget admission, audit, panic, Stop all, and desktop-only administration still apply.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="maia-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="maia-btn maia-btn--danger"
          onClick={onConfirm}
          data-testid="confirm-unrestricted"
        >
          I understand — enable Unrestricted
        </button>
      </div>
    </FocusTrap>
  )
}
