import { useState } from 'react'
import type { CredentialBackendKind } from '@/api/types'
import { SecurityProfileCards } from '@/components/settings/SecurityProfileCards'
import { UnrestrictedConfirmDialog } from '@/components/security/UnrestrictedConfirmDialog'
import { useMaiaState } from '@/hooks/useMaiaState'

const BACKENDS: CredentialBackendKind[] = ['native', 'encrypted_file', 'vault_openbao']

export function OnboardingView() {
  const { state, dispatch } = useMaiaState()
  const [backend, setBackend] = useState<CredentialBackendKind | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const canFinish = backend != null

  return (
    <main className="maia-main" data-testid="onboarding-view">
      <div className="maia-main-body">
        <h1>Welcome to Maia</h1>
        <p>Choose a credential backend and security profile before continuing.</p>

        <section aria-labelledby="onboarding-backend-heading">
          <h2 id="onboarding-backend-heading">Credential backend</h2>
          <div role="radiogroup" aria-label="Onboarding credential backend" className="maia-card-grid">
            {BACKENDS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={backend === option}
                className="maia-profile-card"
                onClick={() => setBackend(option)}
                data-testid={`onboarding-backend-${option}`}
              >
                {option.replace('_', ' ')}
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="onboarding-security-heading">
          <h2 id="onboarding-security-heading">Security profile</h2>
          <SecurityProfileCards onRequestUnrestricted={() => setConfirmOpen(true)} />
        </section>

        <button
          type="button"
          className="maia-btn maia-btn--primary"
          disabled={!canFinish}
          data-testid="finish-onboarding"
          onClick={() => {
            if (!backend) {
              return
            }
            dispatch({ type: 'complete_onboarding', credential_backend: backend })
          }}
        >
          Continue to Maia
        </button>
      </div>

      <UnrestrictedConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          dispatch({
            type: 'confirm_unrestricted',
            confirmed_at: new Date().toISOString(),
            desktop_client_id: state.security.activated_by,
          })
          setConfirmOpen(false)
        }}
      />
    </main>
  )
}
