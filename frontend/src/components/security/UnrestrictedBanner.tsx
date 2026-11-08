import { useMaiaState } from '@/hooks/useMaiaState'
import { selectUnrestrictedBannerVisible } from '@/state/maiaReducer'

export function UnrestrictedBanner() {
  const { state, dispatch } = useMaiaState()
  if (!selectUnrestrictedBannerVisible(state)) {
    return null
  }

  return (
    <div
      className="maia-warning-banner"
      role="status"
      aria-live="polite"
      data-testid="unrestricted-banner"
    >
      <div>
        <strong>Unrestricted</strong> · Full local authority is active on this desktop. Budget,
        audit, panic, and Stop all still apply.
      </div>
      <button
        type="button"
        className="maia-btn maia-btn--primary"
        onClick={() =>
          dispatch({
            type: 'return_to_protected',
            at: new Date().toISOString(),
            by: state.security.activated_by,
          })
        }
      >
        Return to Protected
      </button>
    </div>
  )
}
