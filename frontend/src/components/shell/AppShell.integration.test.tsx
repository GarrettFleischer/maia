import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen, waitFor, within } from '@testing-library/react'
import { createFixtureSuperAgentClient } from '@/api/fixtureSuperAgent'
import { liveSuperAgentClient } from '@/api/liveSuperAgent'
import type { SuperAgentClient } from '@/api/superAgentTypes'
import { AppShell } from '@/components/shell/AppShell'
import { defaultFixtureState } from '@/fixtures/defaultFixture'
import { useMaiaState } from '@/hooks/useMaiaState'
import { renderWithMaia } from '@/test/renderWithMaia'

class FakeSocket {
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  close() {
    this.onclose?.()
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const onboarded = () => ({
  ...defaultFixtureState(),
  onboarding_complete: true,
})

function ActivityProbe() {
  const { state } = useMaiaState()
  return <output data-testid="activity-probe">{`${state.activity.running}/${state.activity.needs_human}`}</output>
}

afterEach(() => {
  vi.unstubAllGlobals()
  window.innerWidth = 1024
  window.dispatchEvent(new Event('resize'))
})

describe('Live shell integration', () => {
  it('renders API transcript messages without fixture-only shell data', async () => {
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') {
          return jsonResponse({ error: 'task_store_unavailable' }, 503)
        }
        if (path === '/api/super-agent/transcript') {
          return jsonResponse({
            messages: [
              { message_id: 'm-live-owner', role: 'owner', text: 'Live owner message' },
              {
                message_id: 'm-live-router',
                role: 'router',
                text: 'The router could not be reached.',
              },
            ],
          })
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )

    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />, {
      initialState: defaultFixtureState(),
    })

    expect(await screen.findByText('Live owner message')).toBeVisible()
    expect(screen.getByText('The router could not be reached.')).toBeVisible()
    expect(screen.queryByTestId('activity-counts')).not.toBeInTheDocument()
    expect(screen.queryByTestId('needs-human-banner')).not.toBeInTheDocument()
    expect(screen.queryByText('Persona · Scout')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Cache' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Brain' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Trace' })).toBeVisible()
    expect(screen.getByText('No context usage for this turn.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeVisible()
  })

  it('renders a live inspector snapshot without fixture copy', async () => {
    const user = userEvent.setup()
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [] })
        if (path === '/api/super-agent/transcript') {
          return jsonResponse({
            messages: [{ message_id: 'm-live', role: 'owner', text: 'Live owner message' }],
          })
        }
        if (path === '/api/super-agent/inspector') {
          return jsonResponse({
            turns: [
              {
                ordinal: 1,
                message_id: 'm-live',
                cached_percent: null,
                slots: [
                  {
                    ordinal: 1,
                    label: 'Route tools',
                    bytes: 12,
                    residence: 'unreported',
                    detail: '5 schemas',
                  },
                  {
                    ordinal: 4,
                    label: 'Conversation',
                    bytes: 5,
                    residence: 'unreported',
                    detail: '1 message',
                  },
                ],
                recall: [],
                thinking: null,
                route: null,
                reply: 'Hello from Maia.',
                trace: [
                  { kind: 'reasoning', text: 'No readable reasoning returned.' },
                  { kind: 'reply', text: 'Hello from Maia.' },
                ],
              },
            ],
          })
        }
        if (path === '/api/brain/map') {
          return jsonResponse({
            nodes: [
              {
                id: 'episode-router',
                kind: 'episode',
                label: 'Router exchange',
                sentence: null,
                taint: 'trusted',
                session_id: 'router',
                held: false,
              },
            ],
            edges: [],
          })
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )

    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)

    expect(await screen.findByText('Route tools')).toBeVisible()
    expect(screen.getByText('Cache not reported')).toBeVisible()
    expect(screen.getByTestId('inspector-live-slot-4')).toHaveTextContent('1 message')
    expect(screen.queryByText('Tailscale')).not.toBeInTheDocument()
    expect(screen.queryByText('Persona · Scout')).not.toBeInTheDocument()
    expect(screen.queryByText(/compact/i)).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Brain' }))
    expect(await screen.findByText('Router exchange')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Trace' }))
    expect(screen.getByText('No readable reasoning returned.')).toBeVisible()
  })

  it('keeps fixture-only shell data out of the live phone surfaces', async () => {
    const user = userEvent.setup()
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [] })
        if (path === '/api/super-agent/transcript') {
          return jsonResponse({
            messages: [{ message_id: 'm-phone', role: 'router', text: 'Live phone transcript' }],
          })
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )

    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)

    await user.click(screen.getByRole('button', { name: (value: string) => value === 'Maia' }))
    expect(await screen.findByText('Live phone transcript')).toBeVisible()
    expect(screen.queryByTestId('phone-stop-bar')).not.toBeInTheDocument()
    expect(screen.queryByTestId('activity-counts')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Inspect' }))
    expect(screen.getByRole('tab', { name: 'Brain' })).toBeVisible()
    expect(screen.getByText('No context usage for this turn.')).toBeVisible()
    expect(screen.queryByText('Persona · Scout')).not.toBeInTheDocument()
  })

  it('keeps fixture-only content out of live tablet surfaces', async () => {
    const user = userEvent.setup()
    window.innerWidth = 900
    window.dispatchEvent(new Event('resize'))
    const client: SuperAgentClient = {
      ...createFixtureSuperAgentClient(),
      dataSource: 'live',
      sidebar: async () => ({ rows: [] }),
      transcript: async () => ({
        messages: [{ message_id: 'm-tablet', role: 'router', text: 'Live tablet transcript' }],
      }),
    }

    renderWithMaia(<AppShell client={client} />)

    expect(await screen.findByText('Live tablet transcript')).toBeVisible()
    expect(screen.queryByTestId('activity-counts')).not.toBeInTheDocument()
    expect(screen.queryByTestId('needs-human-banner')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Inspect' }))
    expect(screen.getByRole('tab', { name: 'Cache' })).toBeVisible()
    expect(screen.getByText('No context usage for this turn.')).toBeVisible()
    expect(screen.queryByText('Persona · Scout')).not.toBeInTheDocument()
  })

  it('treats a persisted routing failure as admitted and renders one safe explanation', async () => {
    const user = userEvent.setup()
    let transcriptReads = 0
    let sends = 0
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [] })
        if (path === '/api/super-agent/transcript') {
          transcriptReads += 1
          return jsonResponse({
            messages:
              transcriptReads === 1
                ? []
                : [
                    { message_id: 'm-owner', role: 'owner', text: 'Route this safely' },
                    {
                      message_id: 'm-router',
                      role: 'router',
                      text: 'The model provider is unavailable.',
                    },
                  ],
          })
        }
        if (path === '/api/super-agent/messages') {
          sends += 1
          return jsonResponse(
            {
              admission: 'admitted',
              message_id: 'm-owner',
              outcome: {
                kind: 'routing_failed',
                reason: 'model_provider_unavailable',
                detail: 'provider=https://private.invalid token=sk-SECRET',
              },
            },
            200,
          )
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )

    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    const composer = await screen.findByRole('textbox', { name: 'Message' })
    await user.type(composer, 'Route this safely')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(
      await within(screen.getByRole('log', { name: 'Router transcript' })).findByText(
        'The model provider is unavailable.',
      ),
    ).toBeVisible()
    await waitFor(() =>
      expect(screen.getAllByText('The model provider is unavailable.')).toHaveLength(1),
    )
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.queryByText('The router could not be reached.')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('private.invalid')
    expect(document.body).not.toHaveTextContent('sk-SECRET')
    const cleared = screen.getByRole('textbox', { name: 'Message' })
    expect(cleared).toHaveValue('')
    expect(cleared).toBeEnabled()
    expect(sends).toBe(1)
  })

  it('retains a live draft when the store fails before admission', async () => {
    const user = userEvent.setup()
    let sends = 0
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [] })
        if (path === '/api/super-agent/transcript') return jsonResponse({ messages: [] })
        if (path === '/api/super-agent/messages') {
          sends += 1
          return jsonResponse({ error: 'task_store_unavailable' }, 500)
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )

    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    const composer = await screen.findByRole('textbox', { name: 'Message' })
    await user.type(composer, 'Retry after recovery')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('status')).toHaveTextContent('The task store is unavailable.')
    expect(composer).toHaveValue('Retry after recovery')
    expect(composer).toBeEnabled()
    expect(sends).toBe(1)
  })

  it('clears the composer after a successful Send button press', async () => {
    const user = userEvent.setup()
    let sends = 0
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [] })
        if (path === '/api/super-agent/transcript') {
          return jsonResponse({
            messages:
              sends === 0
                ? []
                : [{ message_id: 'm-owner', role: 'owner', text: 'Clear after send button' }],
          })
        }
        if (path === '/api/super-agent/messages') {
          sends += 1
          return jsonResponse({
            admission: 'admitted',
            message_id: 'm-owner',
            outcome: { kind: 'routed', route: 'admit' },
          })
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )

    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    const composer = await screen.findByRole('textbox', { name: 'Message' })
    await user.type(composer, 'Clear after send button')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    expect(sends).toBe(1)
  })

  it('clears the composer after a successful Enter keyboard send', async () => {
    const user = userEvent.setup()
    let sends = 0
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [] })
        if (path === '/api/super-agent/transcript') {
          return jsonResponse({
            messages:
              sends === 0
                ? []
                : [{ message_id: 'm-owner', role: 'owner', text: 'Clear after enter key' }],
          })
        }
        if (path === '/api/super-agent/messages') {
          sends += 1
          return jsonResponse({
            admission: 'admitted',
            message_id: 'm-owner',
            outcome: { kind: 'routed', route: 'admit' },
          })
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )

    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    const composer = await screen.findByRole('textbox', { name: 'Message' })
    await user.type(composer, 'Clear after enter key{Enter}')

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    expect(sends).toBe(1)
  })

  it('clears a phone composer whose draft still ends with an Enter newline', async () => {
    const user = userEvent.setup()
    let sends = 0
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [] })
        if (path === '/api/super-agent/transcript') {
          return jsonResponse({
            messages:
              sends === 0
                ? []
                : [{ message_id: 'm-owner', role: 'owner', text: 'phone newline clear' }],
          })
        }
        if (path === '/api/super-agent/messages') {
          sends += 1
          return jsonResponse({
            admission: 'admitted',
            message_id: 'm-owner',
            outcome: { kind: 'routed', route: 'admit' },
          })
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )

    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    await user.click(screen.getByRole('button', { name: (value: string) => value === 'Maia' }))
    const composer = await screen.findByRole('textbox', { name: 'Message' })
    await user.type(composer, 'phone newline clear{Enter}')
    expect(composer).toHaveValue('phone newline clear\n')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(''))
    expect(sends).toBe(1)
  })

  it('keeps the composer text when send fails before admission', async () => {
    const user = userEvent.setup()
    let sends = 0
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [] })
        if (path === '/api/super-agent/transcript') return jsonResponse({ messages: [] })
        if (path === '/api/super-agent/messages') {
          sends += 1
          return jsonResponse({ error: 'empty_message' }, 400)
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )

    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    const composer = await screen.findByRole('textbox', { name: 'Message' })
    await user.type(composer, 'Keep this on failure')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(screen.getByRole('status')).toBeVisible())
    expect(composer).toHaveValue('Keep this on failure')
    expect(sends).toBe(1)
  })

  it('clears an unknown admitted outcome once and uses generic safe copy', async () => {
    const user = userEvent.setup()
    let sends = 0
    let transcriptReads = 0
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [] })
        if (path === '/api/super-agent/transcript') {
          transcriptReads += 1
          if (transcriptReads === 1) return jsonResponse({ messages: [] })
          return jsonResponse({ error: 'task_store_unavailable' }, 500)
        }
        if (path === '/api/super-agent/messages') {
          sends += 1
          return jsonResponse({
            admission: 'admitted',
            message_id: 'm-future',
            outcome: {
              kind: 'future_outcome',
              detail: 'provider=https://private.invalid token=sk-SECRET',
            },
          })
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )

    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    const composer = await screen.findByRole('textbox', { name: 'Message' })
    await user.type(composer, 'Future admitted result')
    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(
      await screen.findAllByText('The message was accepted, but its outcome is unavailable.'),
    ).not.toHaveLength(0)
    await waitFor(() =>
      expect(
        screen.getAllByText('The message was accepted, but its outcome is unavailable.'),
      ).toHaveLength(1),
    )
    expect(screen.getAllByRole('status')).toHaveLength(1)
    const cleared = screen.getByRole('textbox', { name: 'Message' })
    expect(cleared).toHaveValue('')
    expect(cleared).toBeEnabled()
    expect(sends).toBe(1)
    expect(transcriptReads).toBe(2)
    expect(document.body).not.toHaveTextContent('private.invalid')
    expect(document.body).not.toHaveTextContent('sk-SECRET')
  })
})

describe('Stop all wiring', () => {
  it('does not mutate fixture activity when live Stop all is clicked', async () => {
    const user = userEvent.setup()
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    const client: SuperAgentClient = {
      ...createFixtureSuperAgentClient(),
      dataSource: 'live',
    }
    const hostCommand = vi.spyOn(client, 'hostCommand')
    renderWithMaia(
      <>
        <AppShell client={client} />
        <ActivityProbe />
      </>,
      { initialState: onboarded() },
    )

    expect(screen.getByTestId('activity-probe')).toHaveTextContent('2/1')
    const stopAll = await screen.findByLabelText('Stop all running threads')
    await user.click(stopAll)
    expect(hostCommand).toHaveBeenCalledWith({ command: 'stop_all' })
    expect(screen.getByTestId('activity-probe')).toHaveTextContent('2/1')
  })

  it('dispatches stop_all when desktop rail Stop all is clicked', async () => {
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    await user.click(screen.getByLabelText('Stop all running threads'))
    expect(screen.getByTestId('activity-counts')).toHaveTextContent('0 running · 0 needs you')
    expect(screen.queryByTestId('needs-human-banner')).not.toBeInTheDocument()
  })
})

describe('single global stop', () => {
  it('keeps one quiet Stop all and no Panic control on desktop', () => {
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    const rail = screen.getByRole('navigation', { name: 'Chats' })
    const stopAll = within(rail).getByRole('button', { name: 'Stop all running threads' })

    expect(stopAll).toHaveClass('maia-btn')
    expect(stopAll).not.toHaveClass('maia-btn--danger')
    expect(within(rail).queryByRole('button', { name: 'Panic' })).not.toBeInTheDocument()
  })

  it('keeps Stop all inside the open chat and off the phone list', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    expect(screen.queryByRole('button', { name: 'Stop all running threads' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Panic' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: (value: string) => value === 'Maia' }))
    const stopAll = await screen.findByRole('button', { name: 'Stop all running threads' })
    expect(stopAll).toHaveClass('maia-btn')
    expect(stopAll).not.toHaveClass('maia-btn--danger')
  })
})

describe('NeedsHuman integration', () => {
  it('shows capability banner and opens approval sheet from conversation', async () => {
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    const banner = screen.getByTestId('needs-human-banner')
    expect(banner).toHaveTextContent('pwsh -File build.ps1')
    await user.click(within(banner).getByRole('button', { name: /^approve$/i }))
    expect(screen.getByRole('dialog', { name: /approve shell/i })).toBeVisible()
  })

  it('deny clears pending approval from fixture state', async () => {
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    await user.click(screen.getByRole('button', { name: /^deny$/i }))
    expect(screen.queryByTestId('needs-human-banner')).not.toBeInTheDocument()
  })
})

describe('Phone shell controls', () => {
  it('returns from a phone chat to the list on Escape', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    await user.click(screen.getByRole('button', { name: (value: string) => value === 'Maia' }))
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: (value: string) => value === 'Maia' })).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
  })

  it('pins phone stop bar adjacent above composer visually', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: (value: string) => value === 'Maia' }))
    const stopBar = screen.getByTestId('phone-stop-bar')
    const composer = screen.getByTestId('composer')
    const transcript = screen.getByTestId('transcript')
    expect(
      transcript.compareDocumentPosition(stopBar) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      stopBar.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    const gap = composer.getBoundingClientRect().top - stopBar.getBoundingClientRect().bottom
    expect(gap).toBeGreaterThanOrEqual(0)
    expect(gap).toBeLessThanOrEqual(2)
  })
})

describe('Desktop settings navigation', () => {
  it('toggles back to conversation when Settings is clicked again', async () => {
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    expect(screen.getByTestId('transcript')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('heading', { name: 'Model connection' })).toBeVisible()
    expect(screen.getByLabelText('Base URL')).toBeVisible()
    expect(screen.getByLabelText('API key')).toBeVisible()
    expect(screen.getByTestId('security-settings')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByTestId('transcript')).toBeInTheDocument()
  })
})

describe('Phone settings layout', () => {
  it('stacks security profile cards in one column', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const protectedCard = screen.getByTestId('profile-card-protected')
    const allowlistedCard = screen.getByTestId('profile-card-allowlisted')
    expect(allowlistedCard.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      protectedCard.getBoundingClientRect().bottom - 1,
    )
  })

  it('keeps security profile cards within the 390px viewport width', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const viewportWidth = document.documentElement.clientWidth
    const cards = screen.getAllByTestId(/^profile-card-/)
    for (const card of cards) {
      expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(viewportWidth + 0.5)
    }
    const grid = screen.getByTestId('security-profile-cards')
    expect(grid.getBoundingClientRect().width).toBeLessThanOrEqual(viewportWidth + 0.5)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewportWidth + 1)
  })
})

describe('Inspector tabs', () => {
  it('renders cache brain trace tabs in desktop inspector', () => {
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, { initialState: onboarded() })
    expect(screen.getByRole('tab', { name: 'Cache' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Brain' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Trace' })).toBeInTheDocument()
    expect(screen.getByTestId('inspector-cache-slot-slot-tools')).toBeInTheDocument()
    expect(screen.getByTestId('inspector-cache-slot-slot-recall')).toHaveTextContent('Untrusted')
  })
})

const liveRow = {
  task_id: 'task-run',
  title: 'Running task',
  section: 'working' as const,
  phase: 'running' as const,
  summary: 'Working',
  elapsed_ms: 10,
  criteria_done: 0,
  criteria_total: 1,
  children: [],
}

describe('Live phone stop and connection', () => {
  it('shows the phone stop bar when live work is running', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    vi.stubGlobal('WebSocket', class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      close() {
        this.onclose?.()
      }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [liveRow] })
        if (path === '/api/super-agent/transcript') {
          return jsonResponse({ messages: [{ message_id: 'm', role: 'router', text: 'Live running' }] })
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    await user.click(screen.getByRole('button', { name: (value: string) => value === 'Maia' }))
    expect(await screen.findByText('Live running')).toBeVisible()
    expect(screen.getByTestId('phone-stop-bar')).toHaveTextContent('1 running')
    expect(screen.getByRole('button', { name: 'Stop all running threads' })).toBeVisible()
  })

  it('keeps the phone stop bar off when live work is only waiting on the owner', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    vi.stubGlobal('WebSocket', class {
      close() {}
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') {
          return jsonResponse({
            rows: [{ ...liveRow, section: 'needs_you', phase: 'waiting_for_user' }],
          })
        }
        if (path === '/api/super-agent/transcript') {
          return jsonResponse({ messages: [{ message_id: 'm', role: 'router', text: 'Live waiting' }] })
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    await user.click(screen.getByRole('button', { name: (value: string) => value === 'Maia' }))
    expect(await screen.findByText('Live waiting')).toBeVisible()
    expect(screen.queryByTestId('phone-stop-bar')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop all running threads' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Tasks · 1 needs you/ })).toBeVisible()
  })

  it('shows a reconnecting banner and keeps the draft', async () => {
    class Socket {
      static current: Socket | null = null
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      constructor() {
        Socket.current = this
      }
      close() {
        this.onclose?.()
      }
    }
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    vi.stubGlobal('WebSocket', Socket)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/super-agent/sidebar') return jsonResponse({ rows: [] })
        if (path === '/api/super-agent/transcript') {
          return jsonResponse({ messages: [{ message_id: 'm', role: 'router', text: 'Live hello' }] })
        }
        return jsonResponse({ error: 'unknown_route' }, 404)
      }),
    )
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    expect(await screen.findByText('Live hello')).toBeVisible()
    expect(screen.queryByText('Reconnecting to this computer')).not.toBeInTheDocument()
    const composer = screen.getByRole('textbox', { name: 'Message' })
    await user.type(composer, 'keep this')
    Socket.current?.onclose?.()
    expect(await screen.findByText('Reconnecting to this computer')).toBeVisible()
    expect(screen.getByText('http://127.0.0.1:4178')).toBeVisible()
    expect(composer).toHaveValue('keep this')
  })

  it('does not present fixture security settings as live', async () => {
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    vi.stubGlobal('WebSocket', class {
      close() {}
    })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unknown_route' }, 404)))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={liveSuperAgentClient('http://127.0.0.1:4178')} />)
    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    expect(screen.getByText('Agent security settings are not on this screen.')).toBeVisible()
    expect(screen.queryByTestId('security-settings')).not.toBeInTheDocument()
  })
})
