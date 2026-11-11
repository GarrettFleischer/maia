import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { isTailnetOrigin } from '@/remote/phoneAccess'
import { setRemoteCsrf } from '@/remote/csrf'

type Phase = 'ready' | 'checking' | 'unpaired' | 'unauthorized' | 'unreachable'

export function PhoneEntry({ origin, children }: { origin: string; children: ReactNode }) {
  const tailnet = isTailnetOrigin(origin)
  const [phase, setPhase] = useState<Phase>(tailnet ? 'checking' : 'ready')
  const [attempt, setAttempt] = useState(0)
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!tailnet) return
    let cancelled = false
    void fetch(new URL('/api/remote/session', origin), { credentials: 'same-origin' })
      .then(async (response) => {
        if (cancelled) return
        if (response.ok) {
          rememberCsrf(await response.json())
          setPhase('ready')
          return
        }
        const body = await response.json().catch(() => null)
        const error = isRecord(body) && typeof body.error === 'string' ? body.error : ''
        setPhase(error === 'unpaired' ? 'unpaired' : 'unauthorized')
      })
      .catch(() => {
        if (!cancelled) setPhase('unreachable')
      })
    return () => {
      cancelled = true
    }
  }, [origin, tailnet, attempt])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setMessage('')
    const response = await fetch(new URL('/api/remote/pair', origin), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!response.ok) {
      setMessage('That code was not accepted. Read it again from the desktop.')
      return
    }
    rememberCsrf(await response.json())
    setPhase('ready')
  }

  if (phase === 'ready') return children
  if (phase === 'checking') {
    return (
      <section className="maia-settings-section" aria-label="Checking this phone">
        <h1>Maia</h1>
        <p role="status">Checking this phone…</p>
      </section>
    )
  }
  if (phase === 'unauthorized') {
    return (
      <section className="maia-settings-section" aria-label="Phone not authorized">
        <h1>This phone is not authorized</h1>
        <p role="alert">This phone cannot open Maia.</p>
      </section>
    )
  }
  if (phase === 'unreachable') {
    return (
      <section className="maia-settings-section" aria-label="Desktop unreachable">
        <h1>Cannot reach this computer</h1>
        <p>
          Tried <span className="maia-mono">{origin}</span>.
        </p>
        <p>The desktop that runs Maia is unreachable from this phone.</p>
        <button type="button" className="maia-btn" onClick={() => setAttempt((current) => current + 1)}>
          Retry
        </button>
      </section>
    )
  }
  return (
    <form className="maia-settings-section" onSubmit={(event) => void submit(event)} aria-label="Pair this phone">
      <h1>Pair this phone</h1>
      <p>Pair it from the computer that runs Maia. Enter the code shown in Settings on the computer.</p>
      <label>
        Pairing code
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="one-time-code"
          autoCapitalize="characters"
        />
      </label>
      <button type="submit" className="maia-btn">
        Connect this phone
      </button>
      {message ? <p role="alert">{message}</p> : null}
    </form>
  )
}

function rememberCsrf(value: unknown) {
  if (isRecord(value) && typeof value.csrf === 'string') setRemoteCsrf(value.csrf)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
