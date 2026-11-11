import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { ModelConnectionSection } from '@/components/settings/ModelConnectionSection'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const empty = {
  base_url: '',
  key_set: false,
  model: '',
  reasoning: 'medium',
  models: [],
}

describe('ModelConnectionSection', () => {
  it('saves the api key once and never shows it again', async () => {
    const user = userEvent.setup()
    const saved: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          saved.push(JSON.parse(String(init.body)))
          return jsonResponse({
            base_url: 'https://example.test/v1',
            key_set: true,
            model: 'example-chat',
            reasoning: 'high',
            models: [],
          })
        }
        return jsonResponse(empty)
      }),
    )

    render(<ModelConnectionSection source="live" editable />)
    expect(await screen.findByText('Add a Base URL and an API key.')).toBeVisible()
    await user.type(screen.getByLabelText('Base URL'), 'https://example.test/v1')
    await user.type(screen.getByLabelText('API key'), 'sk-hidden-value')
    await user.type(screen.getByLabelText('Model'), 'example-chat')
    await user.click(screen.getByRole('button', { name: 'High' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(saved).toEqual([
      {
        base_url: 'https://example.test/v1',
        model: 'example-chat',
        reasoning: 'high',
        api_key: 'sk-hidden-value',
      },
    ])
    expect(screen.queryByDisplayValue('sk-hidden-value')).not.toBeInTheDocument()
    expect(screen.getByLabelText('API key')).toHaveValue('••••••••')
    expect(screen.getByText('Saved. Future model calls use this connection.')).toBeVisible()
    vi.unstubAllGlobals()
  })

  it('shows the saved connection after the daemon was unreachable', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new TypeError('Failed to fetch')
        return jsonResponse({
          base_url: 'http://127.0.0.1:31415/v1',
          key_set: true,
          model: 'auto',
          reasoning: 'high',
          models: [],
        })
      }),
    )

    render(<ModelConnectionSection source="live" editable />)

    expect(await screen.findByDisplayValue('http://127.0.0.1:31415/v1', {}, { timeout: 3000 })).toBeVisible()
    expect(screen.getByLabelText('Model')).toHaveValue('auto')
    expect(screen.getByText('Saved. Future model calls use this connection.')).toBeVisible()
    vi.unstubAllGlobals()
  })

  it('keeps model connection read-only on the phone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      base_url: 'https://example.test/v1',
      key_set: true,
      model: 'example-chat',
      reasoning: 'medium',
      models: ['example-chat'],
    })))
    render(<ModelConnectionSection source="live" editable={false} />)
    expect(await screen.findByDisplayValue('https://example.test/v1')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue(/sk-/)).not.toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})
