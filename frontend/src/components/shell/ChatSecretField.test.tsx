import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatSecretField } from '@/components/shell/ChatSecretField'

describe('ChatSecretField', () => {
  it('keeps the field masked, toggles reveal, and submits the value', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<ChatSecretField name="RUN67_TEST_KEY" onSubmit={onSubmit} />)
    const input = screen.getByLabelText('RUN67_TEST_KEY')
    expect(input).toHaveAttribute('type', 'password')
    await user.type(input, 'super-secret')
    await user.click(screen.getByRole('button', { name: 'Reveal secret' }))
    expect(input).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: 'Hide secret' }))
    expect(input).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Submit secret' }))
    expect(onSubmit).toHaveBeenCalledWith('super-secret')
  })

  it('shows provided secrets as read-only', () => {
    render(<ChatSecretField name="RUN67_TEST_KEY" provided onSubmit={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent(/provided/i)
    expect(screen.queryByLabelText('RUN67_TEST_KEY')).toBeNull()
  })
})
