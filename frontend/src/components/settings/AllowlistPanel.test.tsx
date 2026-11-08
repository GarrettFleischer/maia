import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen } from '@testing-library/react'
import { AllowlistPanel } from '@/components/settings/AllowlistPanel'
import { defaultFixtureState } from '@/fixtures/defaultFixture'
import { renderWithMaia } from '@/test/renderWithMaia'

describe('AllowlistPanel edit', () => {
  it('persists edited web scope through provider state', async () => {
    const user = userEvent.setup()
    renderWithMaia(<AllowlistPanel />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: true },
    })
    await user.click(screen.getByRole('button', { name: /edit api\.example\.com/i }))
    const hostInput = screen.getByLabelText('Web host')
    await user.clear(hostInput)
    await user.type(hostInput, 'api.staging.example.com')
    await user.click(screen.getByRole('button', { name: /save exact entry/i }))
    expect(screen.getByText('api.staging.example.com/v1/')).toBeInTheDocument()
  })
})
