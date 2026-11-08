import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { ApprovalSheet, ScopeReviewSheet } from '@/components/approval/ApprovalSheet'

describe('ApprovalSheet', () => {
  it('exposes allow once, always allow exact, and deny actions', async () => {
    const user = userEvent.setup()
    const onAllowOnce = vi.fn()
    const onAlwaysAllowExact = vi.fn()
    const onDeny = vi.fn()
    render(
      <ApprovalSheet
        open
        capability="shell"
        targetLabel="pwsh -File build.ps1"
        digest="ab12cd34"
        onAllowOnce={onAllowOnce}
        onAlwaysAllowExact={onAlwaysAllowExact}
        onDeny={onDeny}
        onClose={() => undefined}
      />,
    )
    await user.click(screen.getByRole('button', { name: /allow once/i }))
    await user.click(screen.getByRole('button', { name: /always allow this exact action/i }))
    await user.click(screen.getByRole('button', { name: /^deny$/i }))
    expect(onAllowOnce).toHaveBeenCalledTimes(1)
    expect(onAlwaysAllowExact).toHaveBeenCalledTimes(1)
    expect(onDeny).toHaveBeenCalledTimes(1)
  })
})

describe('ScopeReviewSheet', () => {
  it('shows exact scope summary before save', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <ScopeReviewSheet
        open
        scopeSummary="shell · C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe · [-File, build.ps1]"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    )
    await user.click(screen.getByRole('button', { name: /save exact entry/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
