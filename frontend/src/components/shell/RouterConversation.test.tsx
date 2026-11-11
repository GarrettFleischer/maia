import { useState } from 'react'
import type { ComponentProps, ComponentType } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createFixtureSuperAgentClient, type FixtureSuperAgentClient } from '@/api/fixtureSuperAgent'
import type { ComposerNotice } from '@/api/superAgentTypes'
import { AppShell } from '@/components/shell/AppShell'
import { RouterConversation } from '@/components/shell/RouterConversation'
import { TaskDetail } from '@/components/shell/TaskDetail'
import { TaskRail } from '@/components/shell/TaskRail'
import { useSuperAgent } from '@/hooks/useSuperAgent'
import { renderWithMaia } from '@/test/renderWithMaia'

type ReviewedConversationProps = ComponentProps<typeof RouterConversation> & {
  operation: { kind: 'idle' } | { kind: 'sending' }
  announcement: { sequence: number; message_id: string; text: string } | null
  onAnnouncementAcknowledged: (sequence: number) => void
  admission?: { kind: 'ready' } | { kind: 'blocked'; reason: 'hydrating' | 'hydrate_failed' }
}

const ReviewedRouterConversation = RouterConversation as ComponentType<ReviewedConversationProps>

function RouterHarness({ client }: { client: FixtureSuperAgentClient }) {
  const agent = useSuperAgent(client)
  return (
    <>
      <TaskRail
        rows={agent.rows}
        onOpen={agent.openTask}
        onPin={agent.pin}
      />
      {agent.detail ? (
        <TaskDetail
          detail={agent.detail}
          pin={agent.pinMark}
          operation={agent.operation}
          onClose={agent.closeDetail}
          onQuote={agent.quote}
          onPin={agent.pin}
        />
      ) : (
        <RouterConversation
          messages={agent.messages}
          transcriptState={agent.transcriptState}
          admission={agent.admission}
          operation={agent.operation}
          announcement={agent.announcement}
          draft={agent.draft}
          notice={agent.notice}
          disabled={false}
          onDraftChange={agent.setDraft}
          onRetryTranscript={agent.retryTranscript}
          onAnnouncementAcknowledged={agent.acknowledgeAnnouncement}
          onSubmit={agent.submit}
        />
      )}
    </>
  )
}

function PhoneDraft({ onSubmit }: { onSubmit: () => void }) {
  const [draft, setDraft] = useState('')
  return (
    <RouterConversation
      messages={[]}
      transcriptState={{ kind: 'empty' }}
      admission={{ kind: 'ready' }}
      operation={{ kind: 'idle' }}
      announcement={null}
      draft={draft}
      notice={{ kind: 'idle' }}
      disabled={false}
      submitOnEnter={false}
      onDraftChange={setDraft}
      onRetryTranscript={() => undefined}
      onAnnouncementAcknowledged={() => undefined}
      onSubmit={onSubmit}
    />
  )
}

function DraftHarness({
  initial = '',
  notice = { kind: 'idle' },
  operation = { kind: 'idle' },
  disabled = false,
  onSubmit,
}: {
  initial?: string
  notice?: ComposerNotice
  operation?: { kind: 'idle' } | { kind: 'sending' }
  disabled?: boolean
  onSubmit: () => void
}) {
  const [draft, setDraft] = useState(initial)
  return (
    <RouterConversation
      messages={[{ message_id: 'm1', role: 'owner', text: 'Hello' }]}
      transcriptState={{ kind: 'ready' }}
      admission={{ kind: 'ready' }}
      operation={operation}
      announcement={null}
      draft={draft}
      notice={notice}
      disabled={disabled}
      onDraftChange={setDraft}
      onRetryTranscript={() => undefined}
      onAnnouncementAcknowledged={() => undefined}
      onSubmit={onSubmit}
    />
  )
}

describe('RouterConversation', () => {
  it('keeps admission disabled until transcript hydration succeeds', () => {
    const props = {
      messages: [],
      operation: { kind: 'idle' } as const,
      announcement: null,
      draft: 'Wait for history',
      notice: { kind: 'idle' } as const,
      disabled: false,
      onDraftChange: vi.fn(),
      onRetryTranscript: vi.fn(),
      onAnnouncementAcknowledged: vi.fn(),
      onSubmit: vi.fn(),
    }
    const { rerender } = render(
      <ReviewedRouterConversation
        {...props}
        transcriptState={{ kind: 'loading' }}
        admission={{ kind: 'blocked', reason: 'hydrating' }}
      />,
    )

    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    rerender(
      <ReviewedRouterConversation
        {...props}
        transcriptState={{ kind: 'error', text: 'The conversation could not be loaded.' }}
        admission={{ kind: 'blocked', reason: 'hydrate_failed' }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Retry conversation' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    rerender(
      <ReviewedRouterConversation
        {...props}
        transcriptState={{ kind: 'empty' }}
        admission={{ kind: 'ready' }}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
  })

  it('disables composer and transcript retry while send is pending', () => {
    render(
      <ReviewedRouterConversation
        messages={[]}
        transcriptState={{ kind: 'error', text: 'The conversation could not be loaded.' }}
        admission={{ kind: 'ready' }}
        operation={{ kind: 'sending' }}
        announcement={null}
        draft="Pending send"
        notice={{ kind: 'idle' }}
        disabled={false}
        onDraftChange={vi.fn()}
        onRetryTranscript={vi.fn()}
        onAnnouncementAcknowledged={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Retry conversation' })).toBeDisabled()
  })

  it('keeps one polite announcer empty for history and replaces queued router events by sequence', async () => {
    const props = {
      transcriptState: { kind: 'ready' } as const,
      admission: { kind: 'ready' } as const,
      draft: '',
      notice: { kind: 'idle' } as const,
      disabled: false,
      onDraftChange: vi.fn(),
      onRetryTranscript: vi.fn(),
      onAnnouncementAcknowledged: vi.fn(),
      onSubmit: vi.fn(),
    }
    const { rerender } = render(
      <ReviewedRouterConversation
        {...props}
        operation={{ kind: 'idle' }}
        announcement={null}
        messages={[{ message_id: 'm-initial', role: 'router', text: 'Initial history' }]}
      />,
    )
    const transcript = screen.getByTestId('transcript')
    expect(transcript).toHaveAttribute('role', 'log')
    expect(transcript).toHaveAttribute('aria-live', 'off')
    const announcer = screen.getByTestId('transcript-announcer')
    expect(announcer).toHaveAttribute('aria-live', 'polite')
    expect(announcer).toHaveAttribute('aria-atomic', 'true')
    expect(announcer).toHaveAttribute('aria-relevant', 'additions')
    expect(announcer).toBeEmptyDOMElement()

    rerender(
      <ReviewedRouterConversation
        {...props}
        operation={{ kind: 'idle' }}
        announcement={{ sequence: 1, message_id: 'm-router', text: 'Router append' }}
        messages={[
          { message_id: 'm-initial', role: 'router', text: 'Initial history' },
          { message_id: 'm-owner', role: 'owner', text: 'Owner append' },
          { message_id: 'm-router', role: 'router', text: 'Router append' },
        ]}
      />,
    )

    await waitFor(() => expect(announcer).toHaveTextContent('Router append'))
    expect(announcer).toHaveAttribute('aria-live', 'polite')
    expect(announcer.querySelector('[data-announcement-sequence="1"]')).not.toBeNull()
    expect(announcer).not.toHaveTextContent('Initial history')
    expect(announcer).not.toHaveTextContent('Owner append')

    rerender(
      <ReviewedRouterConversation
        {...props}
        operation={{ kind: 'idle' }}
        announcement={{ sequence: 2, message_id: 'm-router-2', text: 'Next router append' }}
        messages={[
          { message_id: 'm-initial', role: 'router', text: 'Initial history' },
          { message_id: 'm-owner', role: 'owner', text: 'Owner append' },
          { message_id: 'm-router', role: 'router', text: 'Router append' },
          { message_id: 'm-router-2', role: 'router', text: 'Next router append' },
        ]}
      />,
    )
    expect(announcer).toHaveAttribute('aria-live', 'polite')
    expect(announcer).toHaveTextContent('Next router append')
    expect(announcer).not.toHaveTextContent(/^Router append$/)
    expect(announcer.querySelectorAll('[data-announcement-sequence]')).toHaveLength(1)
    expect(announcer.querySelector('[data-announcement-sequence="2"]')).not.toBeNull()
  })

  it('shows a visible You or Router label on each message run', () => {
    render(
      <ReviewedRouterConversation
        messages={[
          { message_id: 'm-owner', role: 'owner', text: 'Owner body' },
          { message_id: 'm-router', role: 'router', text: 'Router body' },
        ]}
        transcriptState={{ kind: 'ready' }}
        admission={{ kind: 'ready' }}
        operation={{ kind: 'idle' }}
        announcement={null}
        draft=""
        notice={{ kind: 'idle' }}
        disabled={false}
        onDraftChange={vi.fn()}
        onRetryTranscript={vi.fn()}
        onAnnouncementAcknowledged={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    const transcript = screen.getByRole('log', { name: 'Router transcript' })
    const list = within(transcript).getByRole('list', { name: 'Transcript messages' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    const owner = within(items[0]!).getByRole('article', { name: 'Message from You' })
    const router = within(items[1]!).getByRole('article', { name: 'Message from Router' })
    expect(owner).toHaveTextContent('Owner body')
    expect(router).toHaveTextContent('Router body')
    expect(within(owner).getByText('You')).toBeVisible()
    expect(within(router).getByText('Router')).toBeVisible()
  })

  it('shows thinking and an admitted route inside the router message', () => {
    render(
      <ReviewedRouterConversation
        messages={[
          {
            message_id: 'm-route',
            role: 'router',
            text: 'Dispatched as one new task: Canby OR.',
            thinking: 'The owner wants the weather.',
            route: 'spawn_task',
          },
        ]}
        transcriptState={{ kind: 'ready' }}
        admission={{ kind: 'ready' }}
        operation={{ kind: 'idle' }}
        announcement={null}
        draft=""
        notice={{ kind: 'idle' }}
        disabled={false}
        onDraftChange={vi.fn()}
        onRetryTranscript={vi.fn()}
        onAnnouncementAcknowledged={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('Thinking')).toBeVisible()
    expect(screen.getByText('The owner wants the weather.')).toBeInTheDocument()
    expect(screen.getByText('Route · admitted by host')).toBeVisible()
    expect(screen.getByText('The host admitted one parent task.')).toBeInTheDocument()
    expect(screen.getByText('Dispatched as one new task: Canby OR.')).toBeVisible()
  })

  it('shows a relay fold for a task report', () => {
    render(
      <ReviewedRouterConversation
        messages={[
          {
            message_id: 'm-relay',
            role: 'router',
            text: 'The task reported: It is 54 F in Canby.',
            route: 'relay_report',
          },
        ]}
        transcriptState={{ kind: 'ready' }}
        admission={{ kind: 'ready' }}
        operation={{ kind: 'idle' }}
        announcement={null}
        draft=""
        notice={{ kind: 'idle' }}
        disabled={false}
        onDraftChange={vi.fn()}
        onRetryTranscript={vi.fn()}
        onAnnouncementAcknowledged={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('Relay · task report')).toBeVisible()
    expect(screen.getByText('Untrusted task report, relayed as text.')).toBeInTheDocument()
    expect(screen.getByText('The task reported: It is 54 F in Canby.')).toBeVisible()
  })

  it('renders duplicate message IDs once and only the current announcement event', () => {
    render(
      <ReviewedRouterConversation
        messages={[
          { message_id: 'm-duplicate', role: 'router', text: 'Visible once' },
          { message_id: 'm-duplicate', role: 'router', text: 'Duplicate hidden' },
        ]}
        transcriptState={{ kind: 'ready' }}
        admission={{ kind: 'ready' }}
        operation={{ kind: 'idle' }}
        announcement={{ sequence: 1, message_id: 'm-one', text: 'Same announcement' }}
        draft=""
        notice={{ kind: 'idle' }}
        disabled={false}
        onDraftChange={vi.fn()}
        onRetryTranscript={vi.fn()}
        onAnnouncementAcknowledged={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    const transcript = screen.getByRole('log', { name: 'Router transcript' })
    expect(within(transcript).getAllByText('Visible once')).toHaveLength(1)
    expect(within(transcript).queryByText('Duplicate hidden')).not.toBeInTheDocument()
    const announcer = screen.getByTestId('transcript-announcer')
    expect(announcer.querySelectorAll('[data-announcement-sequence]')).toHaveLength(1)
    expect(within(announcer).getAllByText('Same announcement')).toHaveLength(1)
  })

  it('renders one queued announcement and explicitly acknowledges it before advancing', () => {
    vi.useFakeTimers()
    const acknowledge = vi.fn()
    try {
      render(
        <ReviewedRouterConversation
          messages={[]}
          transcriptState={{ kind: 'empty' }}
          admission={{ kind: 'ready' }}
          operation={{ kind: 'idle' }}
          announcement={{ sequence: 1, message_id: 'm-one', text: 'First event' }}
          draft=""
          notice={{ kind: 'idle' }}
          disabled={false}
          onDraftChange={vi.fn()}
          onRetryTranscript={vi.fn()}
          onAnnouncementAcknowledged={acknowledge}
          onSubmit={vi.fn()}
        />,
      )

      const announcer = screen.getByTestId('transcript-announcer')
      expect(announcer).toHaveTextContent('First event')
      expect(announcer).not.toHaveTextContent('Second event')
      expect(announcer.querySelectorAll('[data-announcement-sequence]')).toHaveLength(1)

      act(() => vi.advanceTimersByTime(1_000))
      expect(acknowledge).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an empty submit and sends on Enter without a second composer', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<DraftHarness onSubmit={onSubmit} />)
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Write a message before sending.')
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Add a pin control{Enter}')
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('renders HTML-like and long transcript text as inert text', () => {
    const scriptText = '<script>globalThis.compromised = true</script>'
    const longText = `start-${'x'.repeat(10_001)}-end`
    const { container } = render(
      <ReviewedRouterConversation
        messages={[
          { message_id: 'html', role: 'owner', text: scriptText },
          { message_id: 'long', role: 'router', text: longText },
        ]}
        transcriptState={{ kind: 'ready' }}
        admission={{ kind: 'ready' }}
        operation={{ kind: 'idle' }}
        announcement={null}
        draft=""
        notice={{ kind: 'idle' }}
        disabled={false}
        onDraftChange={vi.fn()}
        onRetryTranscript={vi.fn()}
        onAnnouncementAcknowledged={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    const bodies = container.querySelectorAll('.maia-transcript-body')
    expect(bodies[0]?.textContent).toBe(scriptText)
    expect(bodies[1]?.textContent).toContain('start-')
    expect(bodies[1]?.textContent).toContain('-end')
    expect(bodies[1]).toHaveClass('maia-transcript-body')
    expect(container.querySelector('script')).toBeNull()
  })

  it('inserts a newline on Enter when the phone composer only submits from Send', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<PhoneDraft onSubmit={onSubmit} />)
    expect(screen.queryByText('new line')).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'line{Enter}more')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('line\nmore')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('offers Refresh conversation beside the sent-message notice', async () => {
    const user = userEvent.setup()
    const onRetryTranscript = vi.fn()
    render(
      <RouterConversation
        messages={[]}
        transcriptState={{ kind: 'ready' }}
        admission={{ kind: 'ready' }}
        operation={{ kind: 'idle' }}
        announcement={null}
        draft=""
        notice={{
          kind: 'refresh_failed',
          text: 'Message sent. Refresh the conversation to see the latest reply.',
        }}
        disabled={false}
        onDraftChange={vi.fn()}
        onRetryTranscript={onRetryTranscript}
        onAnnouncementAcknowledged={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Message sent. Refresh the conversation to see the latest reply.',
    )
    await user.click(screen.getByRole('button', { name: 'Refresh conversation' }))
    expect(onRetryTranscript).toHaveBeenCalledOnce()
  })

  it('offers Latest message after new text arrives while the transcript is scrolled up', () => {
    const props = {
      transcriptState: { kind: 'ready' as const },
      admission: { kind: 'ready' as const },
      operation: { kind: 'idle' as const },
      announcement: null,
      draft: '',
      notice: { kind: 'idle' as const },
      disabled: false,
      onDraftChange: vi.fn(),
      onRetryTranscript: vi.fn(),
      onAnnouncementAcknowledged: vi.fn(),
      onSubmit: vi.fn(),
    }
    const { rerender } = render(
      <RouterConversation
        {...props}
        messages={[{ message_id: 'm1', role: 'router', text: 'First' }]}
      />,
    )
    const transcript = screen.getByTestId('transcript')
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 400 })
    Object.defineProperty(transcript, 'clientHeight', { configurable: true, value: 100 })
    transcript.scrollTop = 0
    fireEvent.scroll(transcript)
    rerender(
      <RouterConversation
        {...props}
        messages={[
          { message_id: 'm1', role: 'router', text: 'First' },
          { message_id: 'm2', role: 'router', text: 'Second' },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Latest message' }))
    expect(screen.queryByRole('button', { name: 'Latest message' })).not.toBeInTheDocument()
    expect(transcript.scrollTop).toBe(400)
  })

  it('keeps Shift+Enter in the draft', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<DraftHarness onSubmit={onSubmit} />)
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'line{Shift>}{Enter}{/Shift}more')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('line\nmore')
  })

  it('does not send Enter while an IME composition is active', async () => {
    const client = createFixtureSuperAgentClient()
    const send = vi.spyOn(client, 'send')
    render(<RouterHarness client={client} />)
    const box = await screen.findByRole('textbox', { name: 'Message' })
    fireEvent.compositionStart(box)
    fireEvent.compositionUpdate(box, { data: 'ピン' })
    fireEvent.change(box, { target: { value: 'ピン' } })
    fireEvent.keyDown(box, { key: 'Enter', code: 'Enter', isComposing: true })
    expect(send).not.toHaveBeenCalled()
    expect(box).toHaveValue('ピン')
    fireEvent.compositionEnd(box, { data: 'ピン' })
    expect(send).not.toHaveBeenCalled()
    expect(box).toHaveValue('ピン')
  })

  it('replaces the composer when a send clears the draft', () => {
    const props = {
      messages: [] as [],
      transcriptState: { kind: 'empty' as const },
      admission: { kind: 'ready' as const },
      announcement: null,
      notice: { kind: 'idle' as const },
      disabled: false,
      onDraftChange: () => undefined,
      onRetryTranscript: () => undefined,
      onAnnouncementAcknowledged: () => undefined,
      onSubmit: () => undefined,
    }
    const { rerender } = render(
      <ReviewedRouterConversation
        {...props}
        draft="Hello from my phone"
        operation={{ kind: 'sending' }}
      />,
    )
    const first = screen.getByRole('textbox', { name: 'Message' })
    expect(first).toHaveValue('Hello from my phone')

    rerender(
      <ReviewedRouterConversation {...props} draft="" operation={{ kind: 'idle' }} />,
    )

    const next = screen.getByRole('textbox', { name: 'Message' })
    expect(next).not.toBe(first)
    expect(next).toHaveValue('')
    expect(next).toBeEnabled()
  })

  it('speaks pending and failed sends in plain language', () => {
    const { rerender } = render(<DraftHarness operation={{ kind: 'sending' }} onSubmit={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Sending.')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    rerender(<DraftHarness notice={{ kind: 'failed', text: 'Message failed. Try again.' }} onSubmit={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Message failed. Try again.')
  })

  it('inserts a task reference without clearing the draft', async () => {
    const user = userEvent.setup()
    const client = createFixtureSuperAgentClient()
    const insertReference = vi.spyOn(client, 'insertReference')
    render(<RouterHarness client={client} />)
    const box = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(box).toBeEnabled())
    await user.type(box, 'keep this')
    await user.click(await screen.findByRole('button', { name: 'Open Pin control' }))
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Quote task' }))
    expect(insertReference).toHaveBeenCalledWith('task-1')
    await user.click(screen.getByRole('button', { name: 'Quote task' }))
    await user.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('keep this task:task-1 task:task-1 ')
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
  })

  it('quotes into an empty composer as a task reference', async () => {
    const user = userEvent.setup()
    const client = createFixtureSuperAgentClient()
    const insertReference = vi.spyOn(client, 'insertReference')
    render(<RouterHarness client={client} />)
    await user.click(await screen.findByRole('button', { name: 'Open Pin control' }))
    await user.click(screen.getByRole('button', { name: 'Quote task' }))
    expect(insertReference).toHaveBeenCalledWith('task-1')
    await user.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('task:task-1 ')
  })

  it('archives a completed task on detail close unless it is pinned', async () => {
    const user = userEvent.setup()
    const client = createFixtureSuperAgentClient()
    render(<RouterHarness client={client} />)
    await user.click(await screen.findByRole('button', { name: 'Open Pin control' }))
    expect(screen.getByRole('article', { name: 'Task conversation' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back to chat' }))
    const archive = screen.getByRole('region', { name: 'Archive' })
    expect(archive).toHaveTextContent('Pin control')
    expect(screen.queryByRole('region', { name: 'Completed' })).not.toBeInTheDocument()
    await user.click(within(archive).getByText('Archive (1)'))
    await user.click(screen.getByRole('button', { name: 'Pin Pin control' }))
    expect(screen.getByRole('region', { name: 'Pinned' })).toHaveTextContent('Pin control')
    expect(screen.queryByRole('region', { name: 'Archive' })).not.toBeInTheDocument()
  })

  it('speaks a held failure without leaving the draft', async () => {
    const user = userEvent.setup()
    const client = createFixtureSuperAgentClient({ send: 'hold' })
    render(<RouterHarness client={client} />)
    const box = await screen.findByRole('textbox', { name: 'Message' })
    await user.type(box, 'Add a pin control')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByRole('status')).toHaveTextContent('Sending.')
    client.releaseHeldSend('fail')
    expect(await screen.findByRole('status')).toHaveTextContent('Message failed. Try again.')
    expect(box).toHaveValue('Add a pin control')
  })

  it('admits a message into the router transcript', async () => {
    const user = userEvent.setup()
    const client = createFixtureSuperAgentClient()
    render(<RouterHarness client={client} />)
    await user.type(await screen.findByRole('textbox', { name: 'Message' }), 'Add a pin control{Enter}')
    expect(await within(screen.getByRole('log', { name: 'Router transcript' })).findByText('Admitted.')).toBeInTheDocument()
    expect(screen.getByText('Add a pin control')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('')
  })

  it('keeps a helper read-only and refreshes its open detail on Stop all', async () => {
    const user = userEvent.setup()
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    const client = createFixtureSuperAgentClient()
    renderWithMaia(<AppShell client={client} />, { initialState: undefined })
    await user.click(await screen.findByRole('button', { name: 'Expand Pin control' }))
    await user.click(screen.getByRole('button', { name: 'Open Write the control' }))
    const conversation = screen.getByRole('article', { name: 'Task conversation' })
    expect(within(conversation).queryByRole('button', { name: 'Stop this task' })).not.toBeInTheDocument()
    await user.click(screen.getAllByLabelText('Stop all running threads')[0])
    await waitFor(() =>
      expect(within(conversation).getByRole('list', { name: 'Attempts' })).toHaveTextContent('Stopped'),
    )
    expect(within(conversation).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('does not send an empty draft from the hook', async () => {
    const client = createFixtureSuperAgentClient()
    const send = vi.spyOn(client, 'send')
    const { result } = renderHook(() => useSuperAgent(client))
    await act(async () => {
      await result.current.submit()
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('does not open a detail for an unknown task', async () => {
    const user = userEvent.setup()
    const client = createFixtureSuperAgentClient()
    vi.spyOn(client, 'task').mockRejectedValueOnce(new Error('Unknown task.'))
    render(<RouterHarness client={client} />)
    await user.click(await screen.findByRole('button', { name: 'Open Pin control' }))
    expect(screen.queryByRole('article', { name: 'Task conversation' })).not.toBeInTheDocument()
  })

  it('stays quiet when the sidebar cannot load', async () => {
    const client = createFixtureSuperAgentClient()
    vi.spyOn(client, 'sidebar').mockRejectedValue(new Error('offline'))
    render(<RouterHarness client={client} />)
    await waitFor(() => {
      expect(client.sidebar).toHaveBeenCalled()
    })
    expect(screen.queryByRole('button', { name: 'Open Pin control' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument()
  })

  it('distinguishes initial transcript loading from an empty conversation', async () => {
    const client = createFixtureSuperAgentClient()
    let resolveTranscript!: (value: { messages: [] }) => void
    vi.spyOn(client, 'transcript').mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTranscript = resolve
      }),
    )
    render(<RouterHarness client={client} />)

    expect(screen.getByText('Loading conversation.')).toBeVisible()
    resolveTranscript({ messages: [] })
    expect(await screen.findByText('This is the owner chat. Say what you want done; work shows under Tasks.')).toBeVisible()
  })

  it('offers a safe transcript retry after the initial load fails', async () => {
    const user = userEvent.setup()
    const client = createFixtureSuperAgentClient()
    vi.spyOn(client, 'transcript')
      .mockRejectedValueOnce(new Error('provider=https://private.invalid token=sk-SECRET'))
      .mockResolvedValueOnce({ messages: [] })
    render(<RouterHarness client={client} />)

    expect(await screen.findByText('The conversation could not be loaded.')).toBeVisible()
    expect(document.body).not.toHaveTextContent('private.invalid')
    expect(document.body).not.toHaveTextContent('sk-SECRET')
    await user.click(screen.getByRole('button', { name: 'Retry conversation' }))
    expect(await screen.findByText('This is the owner chat. Say what you want done; work shows under Tasks.')).toBeVisible()
  })

  it('speaks ask and refuse results from the fixture', async () => {
    const ask = createFixtureSuperAgentClient({ send: 'ask' })
    await ask.send(ask.createOperationId(), 'Ambiguous')
    expect((await ask.transcript()).messages.at(-1)?.text).toBe('Which task should that change?')
    const refuse = createFixtureSuperAgentClient({ send: 'refuse' })
    expect((await refuse.send(refuse.createOperationId(), 'No')).outcome).toEqual({
      kind: 'routed',
      route: 'refuse',
    })
    expect((await refuse.transcript()).messages.at(-1)?.text).toBe('That message was refused.')
  })
})

describe('fixture client isolation', () => {
  it('does not leak pin, close, or send state across clients', async () => {
    const first = createFixtureSuperAgentClient()
    const second = createFixtureSuperAgentClient()
    await first.pin('task-1', 'pinned')
    await first.closeDetail('task-1')
    await first.send(first.createOperationId(), 'Only the first transcript')
    expect((await first.sidebar()).rows[0]?.section).toBe('pinned')
    expect((await second.sidebar()).rows[0]?.section).toBe('completed')
    expect((await second.transcript()).messages.some((message) => message.text === 'Only the first transcript')).toBe(
      false,
    )
    await second.pin('missing', 'pinned')
    expect((await second.sidebar()).rows[0]?.section).toBe('completed')
    await first.pin('task-1', 'unpinned')
    expect((await first.sidebar()).rows[0]?.section).toBe('archive')
    await first.openDetail('task-1')
    await first.closeDetail('task-1')
    expect((await first.sidebar()).rows[0]?.section).toBe('archive')
    await first.hostCommand({ command: 'stop', task_id: 'child-1' })
    const sidebar = await first.sidebar()
    expect(sidebar.rows).toHaveLength(1)
    expect(sidebar.rows[0]?.phase).toBe('completed')
    expect(sidebar.rows[0]?.children[0]?.phase).toBe('stopped')
    expect(sidebar.rows[0]?.children[0]?.section).toBe('needs_you')
    await first.hostCommand({ command: 'abandon', task_id: 'task-1' })
    expect((await first.sidebar()).rows[0]?.phase).toBe('completed')
    await second.hostCommand({ command: 'stop_all' })
    expect((await second.sidebar()).rows[0]?.phase).toBe('completed')
    expect((await second.sidebar()).rows[0]?.children[0]?.phase).toBe('stopped')
    expect((await first.sidebar()).rows[0]?.children[0]?.phase).toBe('stopped')
  })

  it('holds a stop in needs you and archives only a later cancel', async () => {
    const client = createFixtureSuperAgentClient()
    await client.hostCommand({ command: 'stop', task_id: 'child-1' })
    const held = (await client.sidebar()).rows[0]?.children[0]
    expect(held?.phase).toBe('stopped')
    expect(held?.section).toBe('needs_you')

    await client.hostCommand({ command: 'stop_all' })
    expect((await client.sidebar()).rows[0]?.children[0]?.phase).toBe('stopped')

    await client.hostCommand({ command: 'cancel', task_id: 'child-1' })
    const ended = (await client.sidebar()).rows[0]?.children[0]
    expect(ended?.phase).toBe('cancelled')
    expect(ended?.section).toBe('archive')
  })
})

describe('router shell', () => {
  it('opens a sidebar task from the brain into the conversation and returns to chat', async () => {
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />)
    await user.click(await screen.findByRole('button', { name: 'Brain' }))
    expect(screen.getByRole('heading', { name: 'Brain', level: 1 })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Open Pin control' }))

    const conversation = await screen.findByRole('article', { name: 'Task conversation' })
    const line = within(conversation).getByText(/Editing the control\./)
    expect(line.closest('button')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Brain', level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back to chat' }))

    expect(screen.getByRole('heading', { name: 'Router', level: 1 })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
    expect(screen.queryByRole('article', { name: 'Task conversation' })).not.toBeInTheDocument()
  })

  it('keeps one composer and the existing Stop all behavior', async () => {
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    const client = createFixtureSuperAgentClient()
    const hostCommand = vi.spyOn(client, 'hostCommand')
    renderWithMaia(<AppShell client={client} />, {
      initialState: undefined,
    })
    await user.click(await screen.findByRole('button', { name: 'Open Pin control' }))
    const conversation = screen.getByRole('article', { name: 'Task conversation' })
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(within(conversation).queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(screen.queryByRole('button', { name: 'Panic' })).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('Stop all running threads'))
    expect(hostCommand).toHaveBeenCalledWith({ command: 'stop_all' })
    expect(screen.getByTestId('activity-counts')).toHaveTextContent('0 running · 0 needs you')
  })

  it('shows the task tree in the phone drawer without a second composer', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth + 1)
    await user.click(screen.getByRole('button', { name: /open tasks drawer/i }))
    expect(await screen.findByRole('button', { name: 'Open Pin control' })).toBeInTheDocument()
    expect(screen.getAllByRole('textbox', { hidden: true })).toHaveLength(1)
  })
})
