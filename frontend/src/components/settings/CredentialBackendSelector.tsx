import type { CredentialBackendKind } from '@/api/types'
import { useMaiaState } from '@/hooks/useMaiaState'

const BACKEND_LABELS: Record<CredentialBackendKind, string> = {
  native: 'Native OS store',
  encrypted_file: 'Encrypted local file',
  vault_openbao: 'Vault / OpenBao',
}

export function CredentialBackendSelector() {
  const { state, dispatch } = useMaiaState()
  const readOnly = state.client_class !== 'local_desktop'
  const active = state.credential_backend.active_backend

  return (
    <section aria-labelledby="credential-backend-heading">
      <h3 id="credential-backend-heading">Secrets backend</h3>
      {readOnly ? (
        <p role="note">Change this on the desktop.</p>
      ) : null}
      <div role="radiogroup" aria-label="Credential backend" className="maia-card-grid">
        {(Object.keys(BACKEND_LABELS) as CredentialBackendKind[]).map((backend) => (
          <button
            key={backend}
            type="button"
            role="radio"
            aria-checked={active === backend}
            className="maia-profile-card"
            disabled={readOnly}
            onClick={() => dispatch({ type: 'set_credential_backend', backend })}
            data-testid={`credential-backend-${backend}`}
          >
            <strong>{BACKEND_LABELS[backend]}</strong>
            {backend === 'native' ? (
              <p style={{ margin: '8px 0 0' }}>{state.credential_backend.native_store_label}</p>
            ) : null}
            {backend === 'encrypted_file' ? (
              <p style={{ margin: '8px 0 0' }}>
                Lock state:{' '}
                <span data-testid="encrypted-file-lock-state">
                  {state.encrypted_file_lock_state}
                </span>
                {' · '}
                Idle timeout {state.credential_backend.encrypted_file_idle_timeout_minutes} min
              </p>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  )
}
