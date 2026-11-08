import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PhoneAccessSection } from '@/components/settings/PhoneAccessSection'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const disabled = {
  enabled: false,
  phase: 'disabled',
  url: null,
  reason: null,
  code_active: false,
  devices: [],
}

describe('PhoneAccessSection', () => {
  it('turns phone access on only after the certificate warning is acknowledged', async () => {
    const user = userEvent.setup()
    const bodies: unknown[] = []
    let current = disabled
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/api/remote/enable')) {
          bodies.push(JSON.parse(String(init?.body)))
          current = { ...disabled, enabled: true, phase: 'starting' }
        }
        return json(current)
      }),
    )
    render(<PhoneAccessSection origin="http://127.0.0.1:5173" />)
    await user.click(await screen.findByRole('button', { name: 'Allow phone access' }))
    expect(bodies).toEqual([{ acknowledge_certificate_publication: true }])
    expect(await screen.findByText('Opening the Tailscale address…')).toBeInTheDocument()
  })

  it('hides pairing controls on the phone itself', () => {
    render(<PhoneAccessSection origin="https://gamma.tailc7a62f.ts.net:4178" />)
    expect(screen.getByText('Change pairing on the desktop.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow phone access' })).not.toBeInTheDocument()
  })
})