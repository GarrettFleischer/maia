import { useState } from 'react'
import { AllowlistPanel } from '@/components/settings/AllowlistPanel'
import { CapabilityReportView } from '@/components/settings/CapabilityReportView'
import { CredentialBackendSelector } from '@/components/settings/CredentialBackendSelector'
import { SecurityProfileCards } from '@/components/settings/SecurityProfileCards'
import { UnrestrictedConfirmDialog } from '@/components/security/UnrestrictedConfirmDialog'
import { useMaiaState } from '@/hooks/useMaiaState'

export function SecuritySettingsPage() {
  const { state, dispatch } = useMaiaState()
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <div className="maia-settings-section" data-testid="security-settings">
      <div className="maia-settings-fit">
        <header>
          <h2>Security</h2>
          <p>Profile, platform capabilities, allowlist, and audit status.</p>
        </header>

        <SecurityProfileCards onRequestUnrestricted={() => setConfirmOpen(true)} />

        <CapabilityReportView report={state.capabilities} />

        <section aria-labelledby="audit-heading">
          <h3 id="audit-heading">Audit chain</h3>
          <p>
            Status: <strong>{state.audit.chain_status}</strong> · last verified{' '}
            <span className="maia-mono">{state.audit.last_verified_at}</span>
          </p>
        </section>

        <CredentialBackendSelector />
      </div>

      <div className="maia-settings-scroll">
        <AllowlistPanel />
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
    </div>
  )
}
