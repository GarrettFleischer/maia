import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen } from '@testing-library/react'
import { OnboardingView } from '@/components/onboarding/OnboardingView'
import { defaultFixtureState } from '@/fixtures/defaultFixture'
import { renderWithMaia } from '@/test/renderWithMaia'

describe('OnboardingView', () => {
  it('blocks continue until credential backend is chosen', async () => {
    const user = userEvent.setup()
    renderWithMaia(<OnboardingView />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: false },
    })
    const finish = screen.getByTestId('finish-onboarding')
    expect(finish).toBeDisabled()
    await user.click(screen.getByTestId('onboarding-backend-native'))
    expect(finish).toBeEnabled()
  })

  it('allows keyboard selection of security profiles', async () => {
    const user = userEvent.setup()
    renderWithMaia(<OnboardingView />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: false },
    })
    await user.click(screen.getByTestId('onboarding-backend-encrypted_file'))
    const allowlisted = screen.getByTestId('profile-card-allowlisted')
    allowlisted.focus()
    await user.keyboard('{Enter}')
    expect(allowlisted).toHaveAttribute('aria-checked', 'true')
  })
})
