import { render, type RenderOptions } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { MaiaFixtureState } from '@/api/types'
import { defaultFixtureState, normalizeFixtureState } from '@/fixtures/defaultFixture'
import { MaiaProvider } from '@/hooks/useMaiaState'

export function renderWithMaia(
  ui: ReactElement,
  {
    initialState,
    ...options
  }: RenderOptions & { initialState?: MaiaFixtureState } = {},
) {
  const state = initialState
    ? normalizeFixtureState(initialState)
    : normalizeFixtureState({ ...defaultFixtureState(), onboarding_complete: true })
  return render(<MaiaProvider initialState={state}>{ui}</MaiaProvider>, options)
}
