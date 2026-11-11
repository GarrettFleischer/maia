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
    expect(screen.getByText(/Pair it from the computer that runs Maia/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Pairing code'), 'ABCD-EFGH')
    await user.click(screen.getByRole('button', { name: 'Connect this phone' }))
    expect(await screen.findByText('Phone app')).toBeInTheDocument()
    expect(remoteCsrf()).toBe('csrf-1')
  })

  it('gives the checking state a title before the session answers', async () => {
    let finish: (value: Response) => void = () => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      ),
    )
    render(
      <PhoneEntry origin="https://gamma.tailc7a62f.ts.net:4178">
        <p>Phone app</p>
      </PhoneEntry>,
    )
    expect(screen.getByRole('heading', { name: 'Maia' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Checking this phone…')
    finish(json({ csrf: 'csrf-2' }))
    expect(await screen.findByText('Phone app')).toBeInTheDocument()
  })

  it('does not tell an unauthorized phone to pair from the computer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'forbidden' }, 403)))
    render(
      <PhoneEntry origin="https://gamma.tailc7a62f.ts.net:4178">
        <p>Phone app</p>
      </PhoneEntry>,
    )
    expect(await screen.findByRole('heading', { name: 'This phone is not authorized' })).toBeVisible()
    expect(screen.queryByText(/Pair it from the computer/)).not.toBeInTheDocument()
  })

  it('shows the origin and a retry when the desktop cannot be reached', async () => {
    const user = userEvent.setup()
    const origin = 'https://gamma.tailc7a62f.ts.net:4178'
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new TypeError('Failed to fetch')
        return json({ csrf: 'csrf-3' })
      }),
    )
    render(
      <PhoneEntry origin={origin}>
        <p>Phone app</p>
      </PhoneEntry>,
    )
    expect(await screen.findByRole('heading', { name: 'Cannot reach this computer' })).toBeVisible()
    expect(screen.getByText(origin)).toBeVisible()
    expect(screen.getByText(/unreachable from this phone/)).toBeVisible()
    expect(screen.queryByText(/Pair it from the computer/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Phone app')).toBeInTheDocument()
  })
})
