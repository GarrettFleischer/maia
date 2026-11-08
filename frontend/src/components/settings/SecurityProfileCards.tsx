import type { SecurityProfile } from '@/api/types'
import { useMaiaState } from '@/hooks/useMaiaState'
import { canSelectProfile } from '@/state/maiaReducer'

const PROFILE_COPY: Record<
  SecurityProfile,
  { title: string; body: string }
> = {
  protected: {
    title: 'Protected',
    body: 'Maia prompts for risky actions. Containment stays enabled.',
  },
  allowlisted: {
    title: 'Allowlisted',
    body: 'Matching allowlist entries skip approval prompts only. Grants and containment still apply.',
  },
  unrestricted: {
    title: 'Unrestricted',
    body: 'Controllable gates auto-allow and containment is disabled. Non-bypassable controls still run.',
  },
}

export function SecurityProfileCards({
  onRequestUnrestricted,
}: {
  onRequestUnrestricted: () => void
}) {
  const { state, dispatch } = useMaiaState()
  const active = state.security.profile

  const selectProfile = (profile: SecurityProfile) => {
    const gate = canSelectProfile(profile, state.client_class, active)
    if (!gate.allowed) {
      return
    }
    if (profile === 'unrestricted') {
      onRequestUnrestricted()
      return
    }
    dispatch({ type: 'request_profile', profile })
  }

  return (
    <div
      role="radiogroup"
      aria-label="Security profile"
      className="maia-card-grid"
      data-testid="security-profile-cards"
    >
      {(Object.keys(PROFILE_COPY) as SecurityProfile[]).map((profile) => {
        const gate = canSelectProfile(profile, state.client_class, active)
        const copy = PROFILE_COPY[profile]
        const checked = active === profile
        return (
          <button
            key={profile}
            type="button"
            role="radio"
            aria-checked={checked}
            className="maia-profile-card"
            disabled={!gate.allowed && profile === 'unrestricted'}
            aria-disabled={!gate.allowed && profile === 'unrestricted'}
            onClick={() => selectProfile(profile)}
            data-testid={`profile-card-${profile}`}
          >
            <strong>{copy.title}</strong>
            <p style={{ margin: '8px 0 0' }}>{copy.body}</p>
            {!gate.allowed && profile === 'unrestricted' ? (
              <p style={{ color: 'var(--warning)', marginBottom: 0 }}>{gate.reason}</p>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
