import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { isTailnetOrigin } from '@/remote/phoneAccess'
import { setRemoteCsrf } from '@/remote/csrf'

type Phase = 'ready' | 'checking' | 'pair' | 'denied'

export function PhoneEntry({ origin, children }: { origin: string; children: ReactNode }) {
  const tailnet = isTailnetOrigin(origin)
  const [phase, setPhase] = useState<Phase>(tailnet ? 'checking' : 'ready')
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
        setPhase(error === 'unpaired' ? 'pair' : 'denied')
      })
      .catch(() => {
        if (!cancelled) setPhase('denied')
      })
    return () => {
      cancelled = true
    }
  }, [origin, tailnet])

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
  if (phase === 'checking') return <p role="status">Checking this phone…</p>
  if (phase === 'denied') {
    return (
      <p role="alert">This phone cannot open Maia. Pair it from the computer that runs Maia.</p>
    )
  }
  return (
    <form className="maia-settings-section" onSubmit={(event) => void submit(event)} aria-label="Pair this phone">
      <h1>Pair this phone</h1>
      <p>Enter the code shown in Settings on the computer.</p>
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
