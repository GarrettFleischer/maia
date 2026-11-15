import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ManagerWakeSection } from '@/components/settings/ManagerWakeSection'

describe('ManagerWakeSection', () => {
  it('explains the silent wake schedule in fixture mode', () => {
    render(<ManagerWakeSection source="fixture" editable />)
    expect(screen.getByLabelText('Manager wake')).toBeVisible()
    expect(screen.getByText(/Preview only/i)).toBeVisible()
  })

  it('shows restart budget and mute wake controls in fixture mode', () => {
    render(<ManagerWakeSection source="fixture" editable />)
    expect(screen.getByText(/Restart budget/i)).toBeVisible()
    expect(screen.getByText(/Mute non-essential wake messages/i)).toBeVisible()
  })
})
