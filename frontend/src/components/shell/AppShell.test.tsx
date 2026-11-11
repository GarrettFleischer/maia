import { describe, expect, it, vi } from 'vitest'
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
    expect(await screen.findByText('Nothing has been promoted yet. Episodes remain searchable.')).toBeVisible()
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
    expect(await screen.findByText('Nothing has been promoted yet. Episodes remain searchable.')).toBeVisible()
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
      expect(screen.getByRole('button', { name: 'Open tasks drawer' })).toBeVisible()
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

  it('puts Inspect in the tablet conversation header and marks it pressed while open', async () => {
    window.innerWidth = 900
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: true },
    })
    const inspect = screen.getByRole('button', { name: 'Inspect' })
    expect(inspect.closest('.maia-conv-head')).not.toBeNull()
    expect(inspect).toHaveAttribute('aria-pressed', 'false')
    expect(inspect.getAttribute('style')).toBeNull()
    await user.click(inspect)
    expect(inspect).toHaveAttribute('aria-pressed', 'true')
  })

  it('returns from phone settings to the chat and skips to the conversation', async () => {
    window.innerWidth = 390
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: true },
    })
    const skip = screen.getByRole('link', { name: 'Skip to conversation' })
    expect(skip).toHaveAttribute('href', '#main-content')
    expect(document.querySelector('a, button, input, textarea, select')).toBe(skip)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
  })

  it('stores a light theme from Settings and can follow the system', async () => {
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: true },
    })
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(localStorage.getItem('maia.theme')).toBe('light')
    expect(screen.getByText('In Chrome: Menu → Install app / Add to Home screen.')).toBeVisible()
  })

  it('shows an install button once when the browser offers to install', async () => {
    sessionStorage.removeItem('maia.install.dismissed')
    window.innerWidth = 1440
    window.dispatchEvent(new Event('resize'))
    const user = userEvent.setup()
    const prompt = vi.fn().mockResolvedValue(undefined)
    renderWithMaia(<AppShell client={createFixtureSuperAgentClient()} />, {
      initialState: { ...defaultFixtureState(), onboarding_complete: true },
    })
    const event = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(event, { prompt })
    window.dispatchEvent(event)
    expect(await screen.findByRole('region', { name: 'Install Maia' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Install' }))
    expect(prompt).toHaveBeenCalledOnce()
    expect(screen.queryByRole('region', { name: 'Install Maia' })).not.toBeInTheDocument()
  })
})
