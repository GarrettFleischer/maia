import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NodeChoiceList } from '@/components/brain/NodeChoiceList'

describe('NodeChoiceList', () => {
  it('shows taint as text and moves selection with the arrow keys', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(
      <NodeChoiceList
        label="Brain nodes"
        selectedId="a"
        onSelect={onSelect}
        items={[
          { id: 'a', label: 'Alpha stays.', taint: 'trusted' },
          { id: 'b', label: 'Beta stays.', taint: 'untrusted' },
        ]}
      />,
    )
    expect(screen.getByRole('button', { name: 'Alpha stays. Trusted' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Beta stays. Untrusted' })).toBeVisible()
    screen.getByRole('button', { name: 'Alpha stays. Trusted' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(onSelect).toHaveBeenCalledWith('b')
  })
})
