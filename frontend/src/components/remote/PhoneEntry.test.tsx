import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PhoneEntry } from '@/components/remote/PhoneEntry'
import { remoteCsrf, setRemoteCsrf } from '@/remote/csrf'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('PhoneEntry', () => {
  it('renders the desktop app without asking for a code', () => {
    render(
      <PhoneEntry origin="http://127.0.0.1:5173">
        <p>Desktop</p>
      </PhoneEntry>,
    )
    expect(screen.getByText('Desktop')).toBeInTheDocument()
  })

  it('asks for the pairing code when the phone is unpaired', async () => {
    setRemoteCsrf(null)
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') return json({ csrf: 'csrf-1', state: 'paired' })
        return json({ error: 'unpaired' }, 401)
      }),
    )
    render(
      <PhoneEntry origin="https://gamma.tailc7a62f.ts.net:4178">
        <p>Phone app</p>
      </PhoneEntry>,
    )
    expect(await screen.findByRole('form', { name: 'Pair this phone' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Pairing code'), 'ABCD-EFGH')
    await user.click(screen.getByRole('button', { name: 'Connect this phone' }))
    expect(await screen.findByText('Phone app')).toBeInTheDocument()
    expect(remoteCsrf()).toBe('csrf-1')
  })
})
