import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RouterConversation } from '@/components/shell/RouterConversation'
import { seenKey } from '@/components/shell/unseenMarker'

const message = (id: string, text: string, role: 'owner' | 'router' = 'router') => ({
  message_id: id,
  role,
  text,
})

function renderConversation(
  messages: ReturnType<typeof message>[],
  liveReply: { text: string; dots: boolean } | null = null,
) {
  return render(
    <RouterConversation
      messages={messages}
      transcriptState={{ kind: 'ready' }}
      admission={{ kind: 'ready' }}
      operation={{ kind: 'idle' }}
      announcement={null}
      draft=""
      notice={{ kind: 'idle' }}
      disabled={false}
      onDraftChange={() => undefined}
      onRetryTranscript={() => undefined}
      onAnnouncementAcknowledged={() => undefined}
      onSubmit={() => undefined}
      liveReply={liveReply}
      botId="maia"
    />,
  )
}

describe('live reply', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('streams tokens into the transcript without treating them as the stored answer', () => {
    renderConversation([message('m1', 'Hello')], { text: 'The pin is', dots: false })
    const live = screen.getByTestId('live-reply')
    expect(live).toHaveAttribute('data-final', 'false')
    expect(live).toHaveTextContent('The pin is')
    expect(screen.queryByTestId('stream-dots')).not.toBeInTheDocument()
    expect(screen.getAllByRole('article')).toHaveLength(2)
  })

  it('shows three animated dots at the end of the sentence already received', () => {
    renderConversation([message('m1', 'Hello')], { text: 'The pin is', dots: true })
    const dots = screen.getByTestId('stream-dots')
    expect(dots).toHaveTextContent('...')
    expect(dots.querySelectorAll('span')).toHaveLength(3)
    expect(screen.getByLabelText('Maia is still writing')).toContainElement(dots)
  })
})

describe('unseen marker', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('draws a New line above unseen messages and scrolls to it', async () => {
    const user = userEvent.setup()
    localStorage.setItem(seenKey('maia'), 'm1')
    const scrollIntoView = vi.fn()
    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    renderConversation([
      message('m1', 'Seen already', 'owner'),
      message('m2', 'Not seen yet'),
    ])
    const line = screen.getByTestId('unseen-divider')
    expect(line).toHaveTextContent('New')
    const items = screen.getAllByRole('listitem')
    expect(items[1]).toBe(line)
    expect(items[2]).toHaveTextContent('Not seen yet')
    await user.click(screen.getByTestId('jump-new'))
    expect(scrollIntoView).toHaveBeenCalled()
    expect(localStorage.getItem(seenKey('maia'))).toBe('m1')
  })

  it('keeps the New line after a fresh render of the same browser', () => {
    localStorage.setItem(seenKey('maia'), 'm1')
    const { unmount } = renderConversation([
      message('m1', 'Seen already', 'owner'),
      message('m2', 'Not seen yet'),
    ])
    expect(screen.getByTestId('unseen-divider')).toBeInTheDocument()
    unmount()
    renderConversation([
      message('m1', 'Seen already', 'owner'),
      message('m2', 'Not seen yet'),
    ])
    expect(screen.getByTestId('unseen-divider')).toBeInTheDocument()
    expect(screen.getByText('Not seen yet')).toBeInTheDocument()
  })
})
