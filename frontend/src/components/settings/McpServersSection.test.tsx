import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { McpServersSection } from '@/components/settings/McpServersSection'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const pending = {
  connections: [
    {
      id: 'web',
      label: 'Web',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      status: 'pending approval',
      refresh_error: null,
      admitted_hash: null,
      listed_hash: 'hash-a',
      tools: [{ name: 'scrape', description: 'Read a page' }],
    },
  ],
}

describe('McpServersSection', () => {
  it('hides Admit and Revoke when the phone cannot edit the transport', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(pending)))
    render(<McpServersSection source="live" editable={false} />)
    expect(await screen.findByText('Web: pending approval')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Admit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'List tools' })).toBeNull()
    expect(screen.queryByLabelText('URL')).toBeNull()
  })

  it('admits a listed hash only when editing is allowed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = String(input)
        if (path.endsWith('/admit')) {
          return jsonResponse({
            connections: [{ ...pending.connections[0], status: 'live', admitted_hash: 'hash-a' }],
          })
        }
        return jsonResponse(pending)
      }),
    )
    const user = userEvent.setup()
    render(<McpServersSection source="live" editable />)
    expect(await screen.findByRole('button', { name: 'Admit' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Admit' }))
    expect(await screen.findByText('Web: live')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy()
  })

  it('shows saved servers after the daemon was unreachable', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new TypeError('Failed to fetch')
        return jsonResponse(pending)
      }),
    )

    render(<McpServersSection source="live" editable />)

    expect(await screen.findByText('Web: pending approval', {}, { timeout: 3000 })).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('does not keep the secret on screen after save', async () => {
    const secret = 'super-secret-value'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return jsonResponse({
            connections: [
              {
                ...pending.connections[0],
                status: 'not listed',
                listed_hash: null,
                tools: [],
              },
            ],
          })
        }
        return jsonResponse({ connections: [] })
      }),
    )
    const user = userEvent.setup()
    render(<McpServersSection source="live" editable />)
    await user.type(await screen.findByLabelText('Connection id'), 'web')
    await user.type(screen.getByLabelText('URL'), 'https://mcp.example.com/mcp')
    await user.type(screen.getByLabelText('Secret'), secret)
    await user.click(screen.getByRole('button', { name: 'Add server' }))
    expect(await screen.findByText('Web: not listed')).toBeTruthy()
    expect(screen.getByLabelText('Secret')).toHaveValue('')
    expect(document.body.textContent).not.toContain(secret)
  })
})
