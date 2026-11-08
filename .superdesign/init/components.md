# Shared UI primitives

Framework: Vite + React 19. No component library and no Tailwind. Shared controls are small React components plus Mint Ledger classes in `frontend/src/styles/mint-ledger.css` (`.maia-btn`, `.maia-btn--primary`, `.maia-btn--danger`, `.maia-card-grid`, `.maia-dialog`, `.maia-mono`).

Buttons are `<button type="button" class="maia-btn">`. Primary actions add `maia-btn--primary`. Destructive actions add `maia-btn--danger`. Minimum target height is 40px. Focus uses `:focus-visible` with `--focus-ring`.

### `frontend/src/components/a11y/FocusTrap.tsx`

```tsx
import { useEffect, useRef, type ReactNode } from 'react'

export function FocusTrap({
  active,
  onClose,
  labelId,
  children,
}: {
  active: boolean
  onClose: () => void
  labelId: string
  children: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<Element | null>(null)

  useEffect(() => {
    if (!active) {
      return
    }
    triggerRef.current = document.activeElement
    const container = containerRef.current
    if (!container) {
      return
    }
    const focusables = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    focusables[0]?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || focusables.length === 0) {
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus()
      }
    }
  }, [active, onClose])

  if (!active) {
    return null
  }

  return (
    <div className="maia-dialog-backdrop" role="presentation">
      <div
        ref={containerRef}
        className="maia-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
        {children}
      </div>
    </div>
  )
}

```

### `frontend/src/components/shell/StopAllButton.tsx`

```tsx
import { useStopAllAction } from '@/hooks/useStopAllAction'

export function StopAllButton({ className }: { className?: string }) {
  const stopAll = useStopAllAction()
  return (
    <button
      type="button"
      className={className ?? 'maia-btn maia-btn--danger'}
      aria-label="Stop all running threads"
      onClick={stopAll}
    >
      Stop all
    </button>
  )
}

```

### `frontend/src/components/conversation/NeedsHumanBanner.tsx`

```tsx
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

```

### `frontend/src/components/approval/ApprovalSheet.tsx`

```tsx
import type { ActionMatcher, AllowlistEntryDto } from '@/api/types'
import { FocusTrap } from '@/components/a11y/FocusTrap'
import { useEffect, useState } from 'react'
import { formatAllowlistMatcher } from '@/state/fixtureContracts'

export function ApprovalSheet({
  open,
  capability,
  targetLabel,
  digest,
  onAllowOnce,
  onAlwaysAllowExact,
  onDeny,
  onClose,
}: {
  open: boolean
  capability: string
  targetLabel: string
  digest: string
  onAllowOnce: () => void
  onAlwaysAllowExact: () => void
  onDeny: () => void
  onClose: () => void
}) {
  return (
    <FocusTrap active={open} onClose={onClose} labelId="approval-sheet-title">
      <h2 id="approval-sheet-title">Approve {capability}</h2>
      <p>
        Target: <span className="maia-mono">{targetLabel}</span>
      </p>
      <p>
        Digest: <span className="maia-mono">{digest}</span>
      </p>
      <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
        <button type="button" className="maia-btn maia-btn--primary" onClick={onAllowOnce}>
          Allow once
        </button>
        <button type="button" className="maia-btn" onClick={onAlwaysAllowExact}>
          Always allow this exact action
        </button>
        <button type="button" className="maia-btn maia-btn--danger" onClick={onDeny}>
          Deny
        </button>
      </div>
    </FocusTrap>
  )
}

export function AllowlistEditSheet({
  open,
  entry,
  onSave,
  onCancel,
}: {
  open: boolean
  entry: AllowlistEntryDto | null
  onSave: (patch: { label: string; matcher: ActionMatcher; enabled: boolean }) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [host, setHost] = useState('')
  const [pathPrefix, setPathPrefix] = useState('')
  const [executable, setExecutable] = useState('')
  const [argsText, setArgsText] = useState('')
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    if (!entry) {
      return
    }
    setLabel(entry.label)
    setEnabled(entry.enabled)
    if (entry.matcher.kind === 'web') {
      setHost(entry.matcher.host)
      setPathPrefix(entry.matcher.path_prefix)
    } else {
      setExecutable(entry.matcher.executable)
      setArgsText(entry.matcher.args.join(', '))
    }
  }, [entry])

  if (!entry) {
    return null
  }

  const save = () => {
    if (entry.matcher.kind === 'web') {
      onSave({
        label: `${host}${pathPrefix}`,
        enabled,
        matcher: { kind: 'web', host, path_prefix: pathPrefix },
      })
      return
    }
    onSave({
      label: label || formatAllowlistMatcher(entry.matcher),
      enabled,
      matcher: {
        kind: 'command',
        platform: entry.matcher.platform,
        executable,
        args: argsText
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
      },
    })
  }

  return (
    <FocusTrap active={open} onClose={onCancel} labelId="allowlist-edit-title">
      <h2 id="allowlist-edit-title">Edit allowlist scope</h2>
      <label>
        Label
        <input value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>
      {entry.matcher.kind === 'web' ? (
        <>
          <label>
            Web host
            <input
              aria-label="Web host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />
          </label>
          <label>
            Path prefix
            <input value={pathPrefix} onChange={(event) => setPathPrefix(event.target.value)} />
          </label>
        </>
      ) : (
        <>
          <label>
            Executable
            <input value={executable} onChange={(event) => setExecutable(event.target.value)} />
          </label>
          <label>
            Args (comma separated)
            <input value={argsText} onChange={(event) => setArgsText(event.target.value)} />
          </label>
        </>
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Enabled
      </label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="maia-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="maia-btn maia-btn--primary" onClick={save}>
          Save exact entry
        </button>
      </div>
    </FocusTrap>
  )
}

export function ScopeReviewSheet({
  open,
  scopeSummary,
  onConfirm,
  onCancel,
}: {
  open: boolean
  scopeSummary: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <FocusTrap active={open} onClose={onCancel} labelId="scope-review-title">
      <h2 id="scope-review-title">Review exact allowlist scope</h2>
      <p className="maia-mono">{scopeSummary}</p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="maia-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="maia-btn maia-btn--primary" onClick={onConfirm}>
          Save exact entry
        </button>
      </div>
    </FocusTrap>
  )
}

```

### `frontend/src/components/security/UnrestrictedBanner.tsx`

```tsx
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

```

### `frontend/src/components/security/UnrestrictedConfirmDialog.tsx`

```tsx
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

```

### `frontend/src/components/settings/SecurityProfileCards.tsx`

```tsx
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

```

