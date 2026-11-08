import { useEffect, useRef, useState } from 'react'
import { withCsrf } from '@/remote/csrf'
import { isTailnetOrigin, readDesktopPhoneStatus, type DesktopPhoneStatus } from '@/remote/phoneAccess'

export function PhoneAccessSection({ origin }: { origin: string }) {
  const desktop = !isTailnetOrigin(origin)
  const [status, setStatus] = useState<DesktopPhoneStatus | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const generation = useRef(0)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    const load = () => {
      const ticket = generation.current + 1
      generation.current = ticket
      void fetch(new URL('/api/remote/status', origin), { credentials: 'same-origin' })
        .then(async (response) => (response.ok ? readDesktopPhoneStatus(await response.json()) : null))
        .then((next) => {
          if (!cancelled && ticket === generation.current && next) setStatus(next)
        })
        .catch(() => {
          if (!cancelled && ticket === generation.current) setMessage('Phone access status could not be read.')
        })
    }
    load()
    const timer = window.setInterval(load, status?.phase === 'starting' ? 1000 : 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [desktop, origin, status?.phase])

  async function enable() {
    setMessage('')
    const ticket = generation.current + 1
    generation.current = ticket
    const response = await fetch(new URL('/api/remote/enable', origin), {
      method: 'POST',
      credentials: 'same-origin',
      headers: withCsrf('POST', { 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify({ acknowledge_certificate_publication: true }),
    })
    if (!response.ok) {
      setMessage('Phone access could not be turned on.')
      return
    }
    const next = readDesktopPhoneStatus(await response.json())
    if (next && ticket === generation.current) setStatus(next)
  }

  async function createCode() {
    setMessage('')
    const response = await fetch(new URL('/api/remote/pairing-code', origin), {
      method: 'POST',
      credentials: 'same-origin',
      headers: withCsrf('POST', { accept: 'application/json' }),
    })
    if (!response.ok) {
      setMessage('A pairing code could not be created.')
      return
    }
    const body = (await response.json()) as { code?: string }
    setCode(typeof body.code === 'string' ? body.code : null)
  }

  async function unpair(nodeId: string) {
    const response = await fetch(new URL('/api/remote/unpair', origin), {
      method: 'POST',
      credentials: 'same-origin',
      headers: withCsrf('POST', { 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify({ node_id: nodeId }),
    })
    if (!response.ok) return
    const next = readDesktopPhoneStatus(await response.json())
    if (next) setStatus(next)
  }

  if (!desktop) {
    return (
      <section className="maia-settings-section" aria-labelledby="phone-access-heading">
        <h2 id="phone-access-heading">Phone</h2>
        <p>Change pairing on the desktop.</p>
      </section>
    )
  }

  return (
    <section className="maia-settings-section" aria-labelledby="phone-access-heading">
      <h2 id="phone-access-heading">Phone</h2>
      <p>
        Phone access uses this computer’s Tailscale name over HTTPS. Issuing the certificate publishes
        that name in public certificate logs. The tailnet also needs Enable HTTPS turned on under DNS
        in the Tailscale admin console.
      </p>
      {status?.phase === 'ready' && status.url ? (
        <p>
          On your phone, open <span className="maia-mono">{status.url}</span>
        </p>
      ) : null}
      {status?.reason ? <p role="status">{status.reason}</p> : null}
      {status?.phase === 'starting' ? <p role="status">Opening the Tailscale address…</p> : null}
      {status?.phase !== 'ready' ? (
        <button type="button" className="maia-btn" onClick={() => void enable()}>
          Allow phone access
        </button>
      ) : (
        <button type="button" className="maia-btn" onClick={() => void createCode()}>
          Create a pairing code
        </button>
      )}
      {code ? (
        <p>
          Pairing code <strong className="maia-mono">{code}</strong>
        </p>
      ) : null}
      {status && status.devices.length > 0 ? (
        <ul>
          {status.devices.map((device) => (
            <li key={device.node_id}>
              {device.name}{' '}
              <button type="button" className="maia-btn" onClick={() => void unpair(device.node_id)}>
                Unpair {device.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
    </section>
  )
}
