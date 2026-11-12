import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { BotSummary } from '@/api/superAgentTypes'
import { BotList, relativeChatTime } from '@/components/shell/BotList'

function bot(overrides: Partial<BotSummary> & Pick<BotSummary, 'bot_id' | 'name'>): BotSummary {
  return {
    color: '#6f8f7a',
    instructions: '',
    pinned: false,
    archived: false,
    preview: '',
    last_message_at: null,
    unread: 0,
    running: false,
    status_line: '',
    ...overrides,
  }
}

describe('BotList', () => {
  it('shows a preview, a relative time, and an unread count', () => {
    const now = 1_700_000_000_000
    render(
      <BotList
        now={now}
        selectedId="maia"
        bots={[
          bot({
            bot_id: 'maia',
            name: 'Maia',
            preview: 'Yes. Same UI over Tailscale.',
            status_line: 'Working on the phone layout',
            last_message_at: now - 5 * 60_000,
            unread: 2,
          }),
        ]}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onPin={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    expect(screen.getByText('Yes. Same UI over Tailscale.')).toBeVisible()
    expect(screen.getByText('Working on the phone layout')).toBeVisible()
    expect(screen.getByText('5m')).toBeVisible()
    expect(screen.getByText('2')).toBeVisible()
    expect(relativeChatTime(now - 30_000, now)).toBe('now')
  })

  it('filters by name and keeps archived bots in a collapsed section', async () => {
    const user = userEvent.setup()
    render(
      <BotList
        selectedId="maia"
        bots={[
          bot({ bot_id: 'maia', name: 'Maia', preview: 'hello' }),
          bot({ bot_id: 'bot-2', name: 'Coding', preview: 'dog house', archived: true }),
        ]}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onPin={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    const archivedSection = screen.getByText('Archived').closest('details')
    expect(archivedSection).not.toHaveAttribute('open')
    await user.type(screen.getByRole('textbox', { name: 'Search chats' }), 'dog')
    expect(screen.queryByRole('button', { name: (value: string) => value === 'Maia' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: (value: string) => value === 'Coding' })).toBeVisible()
  })

  it('creates a bot from a name and optional instructions', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    render(
      <BotList
        selectedId="maia"
        bots={[bot({ bot_id: 'maia', name: 'Maia' })]}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onRename={vi.fn()}
        onPin={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'New bot' }))
    await user.type(screen.getByRole('textbox', { name: 'Bot name' }), 'Arise')
    await user.type(screen.getByRole('textbox', { name: 'Standing instructions' }), 'this one is for Arise')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith({ name: 'Arise', instructions: 'this one is for Arise' })
  })

  it('selects a row immediately', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    function Harness() {
      const [selected, setSelected] = useState('maia')
      return (
        <BotList
          selectedId={selected}
          bots={[
            bot({ bot_id: 'maia', name: 'Maia', preview: 'one' }),
            bot({ bot_id: 'bot-2', name: 'Coding', preview: 'two' }),
          ]}
          onSelect={(id) => {
            onSelect(id)
            setSelected(id)
          }}
          onCreate={vi.fn()}
          onRename={vi.fn()}
          onPin={vi.fn()}
          onArchive={vi.fn()}
          onDelete={vi.fn()}
        />
      )
    }
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: (value: string) => value === 'Coding' }))
    expect(onSelect).toHaveBeenCalledWith('bot-2')
    expect(screen.getByRole('button', { name: (value: string) => value === 'Coding' })).toHaveAttribute('aria-current', 'page')
  })
})
