import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createFixtureSuperAgentClient } from '@/api/fixtureSuperAgent'
import { AppShell } from '@/components/shell/AppShell'
import { defaultFixtureState } from '@/fixtures/defaultFixture'
import { renderWithMaia } from '@/test/renderWithMaia'

describe('AppShell layout', () => {
  it('requires an explicit client at the shell boundary', () => {
    const omittedClient = () => {
      // @ts-expect-error AppShell must fail closed when no client is composed.
      return <AppShell />
    }
    expect(omittedClient).toBeTypeOf('function')
  })

  it('frames the desktop like the Mint Ledger mockup', () => {
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: true },
    })
    expect(screen.getByRole('banner', { name: 'Maia' })).toBeVisible()
    expect(screen.getByRole('navigation', { name: 'Tasks' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Router' })).toBeVisible()
    expect(screen.getByText(/One conversation/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Stop all running threads' })).toHaveTextContent(
      'Stop all running threads',
    )
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Message Router')
  })

  it('keeps composer below transcript without vertical overlap', () => {
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />)
    const transcript = screen.getByTestId('transcript')
    const composer = screen.getByTestId('composer')
    const transcriptBottom = transcript.getBoundingClientRect().bottom
    const composerTop = composer.getBoundingClientRect().top
    expect(composerTop).toBeGreaterThanOrEqual(transcriptBottom - 1)
  })

  it('opens the shared brain map from the rail', async () => {
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: true },
    })
    await user.click(screen.getByRole('button', { name: 'Brain' }))
    expect(screen.getByRole('heading', { name: 'Brain' })).toBeVisible()
    expect(await screen.findByText('No facts in the brain yet.')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
  })

  it('opens the shared brain from the phone header', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: true },
    })
    await user.click(screen.getByRole('button', { name: 'Brain' }))
    expect(screen.getByRole('heading', { name: 'Brain' })).toBeVisible()
    expect(await screen.findByText('No facts in the brain yet.')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
  })

  it('opens the brain as its own phone screen and returns to the chat', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: true },
    })
    await user.click(screen.getByRole('button', { name: 'Brain' }))
    expect(screen.getByRole('region', { name: 'Brain' })).toHaveClass('maia-phone-screen')
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Chat' }))
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Brain' })).not.toBeInTheDocument()
  })

  it('uses the phone shell when the CSS viewport is a phone even if innerWidth is the wide track', () => {
    window.innerWidth = 728
    const previous = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes('max-width: 727px'),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false
        },
      }),
    })
    window.dispatchEvent(new Event('resize'))
    try {
      renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, {
        initialState: { ...defaultFixtureState(), onboarding_complete: true },
      })
      expect(screen.getByTestId('app-shell')).toHaveAttribute('data-viewport', 'phone')
      expect(screen.getByRole('button', { name: 'Open agents drawer' })).toBeVisible()
    } finally {
      if (previous) Object.defineProperty(window, 'matchMedia', previous)
      else Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('shows global stop on phone layout when threads run', () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />)
    expect(screen.getByTestId('phone-stop-bar')).toBeVisible()
  })

  it('renders unrestricted banner above main content when active', () => {
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, {
      initialState: {
        ...defaultFixtureState(),
        onboarding_complete: true,
        security: {
          profile: 'unrestricted',
          activated_at: '2026-11-05T10:00:00Z',
          activated_by: 'owner-desktop-1',
          local_unrestricted_confirmation: {
            confirmed_at: '2026-11-05T10:00:00Z',
            desktop_client_id: 'owner-desktop-1',
          },
        },
      },
    })
    expect(screen.getByTestId('unrestricted-banner')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Stop all running threads').length).toBeGreaterThanOrEqual(1)
  })
})
