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
