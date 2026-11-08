import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { cleanup, screen, within } from '@testing-library/react'
import { SecuritySettingsPage } from '@/components/settings/SecuritySettingsPage'
import { UnrestrictedBanner } from '@/components/security/UnrestrictedBanner'
import { defaultFixtureState, remoteClientFixture } from '@/fixtures/defaultFixture'
import { renderWithMaia } from '@/test/renderWithMaia'

describe('SecuritySettingsPage', () => {
  it('shows capability probes with textual pass/fail reasons', () => {
    renderWithMaia(<SecuritySettingsPage />)
    const table = screen.getByTestId('capability-report-table')
    expect(within(table).getByText('appcontainer')).toBeInTheDocument()
    expect(within(table).getAllByText('Ready')).toHaveLength(2)
  })

  it('disables unrestricted selection for remote clients', async () => {
    renderWithMaia(<SecuritySettingsPage />, { initialState: remoteClientFixture() })
    const unrestricted = screen.getByTestId('profile-card-unrestricted')
    expect(unrestricted).toBeDisabled()
    expect(within(screen.getByTestId('profile-card-unrestricted')).getByText('Change this on the desktop.')).toBeInTheDocument()
  })

  it('requires local confirmation before enabling unrestricted', async () => {
    const user = userEvent.setup()
    renderWithMaia(<SecuritySettingsPage />)
    await user.click(screen.getByTestId('profile-card-unrestricted'))
    expect(screen.getByRole('dialog', { name: /enable unrestricted profile/i })).toBeInTheDocument()
    await user.click(screen.getByTestId('confirm-unrestricted'))
    expect(screen.getByTestId('profile-card-unrestricted')).toHaveAttribute('aria-checked', 'true')
  })

  it('filters allowlist rows via search', async () => {
    const user = userEvent.setup()
    renderWithMaia(<SecuritySettingsPage />)
    await user.type(screen.getByTestId('allowlist-search'), 'build.ps1')
    expect(screen.getByTestId('allowlist-row-grant-1')).toBeInTheDocument()
    expect(screen.queryByTestId('allowlist-row-grant-2')).not.toBeInTheDocument()
  })
})

describe('credential backend selector', () => {
  it('marks encrypted file lock state and blocks remote edits', () => {
    renderWithMaia(<SecuritySettingsPage />)
    expect(screen.getByTestId('encrypted-file-lock-state')).toHaveTextContent('unlocked')
    cleanup()
    renderWithMaia(<SecuritySettingsPage />, { initialState: remoteClientFixture() })
    expect(screen.getByTestId('credential-backend-native')).toBeDisabled()
  })
})

describe('Unrestricted banner persistence', () => {
  it('stays visible on settings view until return to protected', async () => {
    const user = userEvent.setup()
    const unrestricted = {
      ...defaultFixtureState(),
      onboarding_complete: true,
      security: {
        profile: 'unrestricted' as const,
        activated_at: '2026-11-05T10:00:00Z',
        activated_by: 'owner-desktop-1',
        local_unrestricted_confirmation: {
          confirmed_at: '2026-11-05T10:00:00Z',
          desktop_client_id: 'owner-desktop-1',
        },
      },
    }
    renderWithMaia(
      <>
        <UnrestrictedBanner />
        <SecuritySettingsPage />
      </>,
      { initialState: unrestricted },
    )
    const banner = screen.getByTestId('unrestricted-banner')
    expect(banner).toBeVisible()
    await user.click(screen.getByRole('button', { name: /return to protected/i }))
    expect(screen.queryByTestId('unrestricted-banner')).not.toBeInTheDocument()
  })
})
