import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatQuestionCard } from '@/components/shell/ChatQuestionCard'

describe('ChatQuestionCard', () => {
  it('submits radio, multi-select, and Other together', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <ChatQuestionCard
        questions={[
          {
            id: 'channel',
            prompt: 'Channel?',
            kind: 'single',
            choices: ['email', 'sms'],
          },
          {
            id: 'topics',
            prompt: 'Topics?',
            kind: 'multi',
            choices: ['a', 'b'],
          },
        ]}
        onSubmit={onSubmit}
      />,
    )
    await user.click(screen.getByLabelText('email'))
    await user.click(screen.getByLabelText('a'))
    const others = screen.getAllByPlaceholderText('Other')
    await user.type(others[1]!, 'custom')
    await user.click(screen.getByRole('button', { name: 'Submit answers' }))
    expect(onSubmit).toHaveBeenCalledWith([
      { id: 'channel', selected: ['email'], other: '' },
      { id: 'topics', selected: ['a'], other: 'custom' },
    ])
  })

  it('shows answered cards as read-only', () => {
    render(
      <ChatQuestionCard
        questions={[
          {
            id: 'channel',
            prompt: 'Channel?',
            kind: 'single',
            choices: ['email'],
          },
        ]}
        answers={[{ id: 'channel', selected: ['email'], other: '' }]}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Answered')
    expect(screen.queryByRole('button', { name: 'Submit answers' })).toBeNull()
    expect(screen.getByLabelText('email')).toBeDisabled()
  })
})
